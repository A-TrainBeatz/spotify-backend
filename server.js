const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const app = express();
app.use(cors());

const PORT = Number(process.env.PORT) || 3000;

// FIXED: Dynamically matches your exact Spotify dashboard HTTPS Redirect URIs
const REDIRECT_URI = process.env.REDIRECT_URI || 
  (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/callback` : `https://127.0.0.1:${PORT}/callback`);

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
// SPOTIFY AUTHORIZATION ROUTES
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

  // FOOLPROOF FIX: Uses standard string concatenation so template literals can't fail
  res.redirect("https://spotify.com?" + params.toString());
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

    accessToken = access_token;
    tokenExpiresAt = Date.now() + (response.data.expires_in || 3600) * 1000;

    // Outputs directly to your server workspace terminal logs
    console.log("\n=============================================");
    console.log("🎉 SUCCESS! YOUR REFRESH TOKEN IS BELOW:");
    console.log(refresh_token);
    console.log("=============================================\n");

    // FIXED: Prints the Refresh Token directly on-screen so you can grab it instantly
    res.send(`
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #121212; color: #ffffff; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 20px; box-sizing: border-box;">
        <div style="background: #1e1e1e; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); max-width: 600px; width: 100%; text-align: center;">
          <h1 style="color: #1db954; font-size: 2.2rem; margin-bottom: 10px;">🎉 Login Successful!</h1>
          <p style="color: #bbb; margin-bottom: 25px;">Copy the code block below and save it as your <code>REFRESH_TOKEN</code> variable inside Render.</p>
          
          <div style="position: relative; background: #000000; padding: 15px; border-radius: 6px; border: 1px solid #333; margin-bottom: 25px; word-break: break-all; text-align: left; font-family: monospace; font-size: 0.95rem; color: #1db954; user-select: all;">
            ${refresh_token}
          </div>

          <p style="font-size: 0.85rem; color: #777; line-height: 1.4;">
            Once you add <strong>REFRESH_TOKEN</strong> to your environment variables tab on Render and click <strong>Save Changes</strong>, your widget will start displaying your live music status cleanly!
          </p>
        </div>
      </div>
    `);
  } catch (error) {
    console.error("Error exchanging authorization code:", error.response?.data || error.message);
    res.status(500).send("Authentication failed. Check your console logs.");
  }
});

// =========================================================================
// CORE API ENDPOINTS
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
