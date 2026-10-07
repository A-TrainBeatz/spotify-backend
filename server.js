const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const app = express();
app.use(cors());

const PORT = Number(process.env.PORT) || 3000;

// Dynamic Redirect URI based on environment
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;

let accessToken = "";
let tokenExpiresAt = 0;
let refreshPromise = null;

function validateEnvironment() {
  const required = ["CLIENT_ID", "CLIENT_SECRET"];
  const missing = required.filter(name => !process.env[name]);

  if (missing.length > 0) {
    console.warn(`⚠️ Warning: Missing core environment variables: ${missing.join(", ")}`);
    return false;
  }
  return true;
}

// =========================================================================
// NEW: SPOTIFY AUTHORIZATION ROUTES (To generate your REFRESH_TOKEN)
// =========================================================================

app.get("/login", (req, res) => {
  if (!process.env.CLIENT_ID) {
    return res.status(500).send("CLIENT_ID is missing from your environment variables.");
  }

  const scope = "user-read-currently-playing user-read-playback-state";
  
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.CLIENT_ID,
    scope: scope,
    redirect_uri: REDIRECT_URI,
  });

  // FIXED: Backticks used, and uppercase S in toString()
  res.redirect(`https://spotify.com{params.toString()}`);
});


app.get("/callback", async (req, res) => {
  const code = req.query.code || null;
  
  if (!code) {
    return res.status(400).send("Authorization code missing from query parameters.");
  }

  try {
    const credentials = Buffer.from(
      `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
    ).toString("base64");

    const response = await axios.post(
      "https://spotify.com",
      new URLSearchParams({
        code: code,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code"
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    const { refresh_token, access_token } = response.data;

    // Cache the initial access token
    accessToken = access_token;
    tokenExpiresAt = Date.now() + (response.data.expires_in || 3600) * 1000;

    // Log to terminal for easy copying
    console.log("\n=============================================");
    console.log("🎉 SUCCESS! YOUR REFRESH TOKEN IS BELOW:");
    console.log(refresh_token);
    console.log("=============================================\n");

    res.send(`
      <h1>Login Successful!</h1>
      <p>Check your <strong>terminal/console logs</strong> to copy your <code>REFRESH_TOKEN</code>.</p>
      <p>Add it to your environment variables (.env file) and restart your server.</p>
    `);
  } catch (error) {
    console.error("Error exchanging authorization code:", error.response?.data || error.message);
    res.status(500).send("Authentication failed. Check your console logs.");
  }
});

// =========================================================================
// EXISTNG UTILITIES & CORE ENDPOINTS
// =========================================================================

async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      if (!validateEnvironment() || !process.env.REFRESH_TOKEN) {
        throw new Error("REFRESH_TOKEN is not configured yet. Visit /login first.");
      }

      const credentials = Buffer.from(
        `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
      ).toString("base64");

      const response = await axios.post(
        "https://spotify.com",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: process.env.REFRESH_TOKEN
        }).toString(),
        {
          headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          timeout: 15000
        }
      );

      if (!response.data?.access_token) {
        throw new Error("Spotify did not return an access token.");
      }

      accessToken = response.data.access_token;
      const expiresIn = Number(response.data.expires_in) || 3600;
      tokenExpiresAt = Date.now() + Math.max(expiresIn - 60, 60) * 1000;

      console.log(`Access token refreshed at ${new Date().toLocaleTimeString()}`);
      return accessToken;
    } catch (error) {
      accessToken = "";
      tokenExpiresAt = 0;
      console.error("Error refreshing Spotify token:", error.response?.data || error.message);
      throw error;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function getValidAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  return refreshAccessToken();
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "spotify-backend", endpoint: "/now-playing" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, spotifyTokenAvailable: Boolean(accessToken), tokenExpiresAt });
});

app.get("/now-playing", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const response = await axios.get(
      "https://spotify.com",
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
        validateStatus: status => status >= 200 && status < 300
      }
    );

    if (response.status === 204 || !response.data || !response.data.item) {
      return res.status(204).end();
    }
    return res.json(response.data);
  } catch (error) {
    const spotifyStatus = error.response?.status;
    if (spotifyStatus === 401) {
      try {
        const newToken = await refreshAccessToken();
        const retry = await axios.get(
          "https://spotify.com",
          { headers: { Authorization: `Bearer ${newToken}` }, timeout: 15000 }
        );
        if (retry.status === 204 || !retry.data || !retry.data.item) return res.status(204).end();
        return res.json(retry.data);
      } catch (e) { /* ignore */ }
    }
    if (spotifyStatus === 403) {
      return res.status(403).json({ error: "Spotify denied access. Verify account developer configurations." });
    }
    return res.status(502).json({ error: "Failed to fetch data." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

refreshAccessToken().catch(() => {
  console.log("No initial token loaded. Visit /login to set up authorization.");
});

setInterval(() => {
  refreshAccessToken().catch(() => {});
}, 50 * 60 * 1000);
