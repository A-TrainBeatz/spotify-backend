const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");
const crypto = require("crypto");

dotenv.config();

const app = express();
app.use(cors());

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `${BASE_URL}/callback`;
const OAUTH_SCOPE = "streaming user-read-currently-playing user-read-playback-state user-modify-playback-state";
const oauthStates = new Set();

let accessToken = "";
let tokenExpiresAt = 0;
let refreshPromise = null;

function validateEnvironment() {
  const required = ["CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN"];
  const missing = required.filter(name => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

async function refreshAccessToken() {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      validateEnvironment();

      const credentials = Buffer.from(
        `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
      ).toString("base64");

      const response = await axios.post(
        "https://accounts.spotify.com/api/token",
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

      console.log(
        `Access token refreshed at ${new Date().toLocaleTimeString()}`
      );

      return accessToken;
    } catch (error) {
      accessToken = "";
      tokenExpiresAt = 0;

      console.error(
        "Error refreshing Spotify token:",
        error.response?.data || error.message
      );

      throw error;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function getValidAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) {
    return accessToken;
  }

  return refreshAccessToken();
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "spotify-backend",
    endpoints: ["/login", "/callback", "/now-playing", "/health", "/transfer-playback"]
  });
});

// Starts Spotify's Authorization Code flow.
// Add this exact redirect URI to the Redirect URI allowlist in your Spotify app:
// https://spotify-backend-pkqi.onrender.com/callback
app.get("/login", (req, res) => {
  try {
    validateEnvironment();

    const state = crypto.randomBytes(24).toString("hex");
    oauthStates.add(state);

    const authUrl = new URL("https://accounts.spotify.com/authorize");
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: process.env.CLIENT_ID,
      scope: OAUTH_SCOPE,
      redirect_uri: REDIRECT_URI,
      state
    }).toString();

    return res.redirect(authUrl.toString());
  } catch (error) {
    console.error("Unable to start Spotify login:", error.message);
    return res.status(500).send("Spotify login is not configured correctly on the server.");
  }
});

// Spotify sends the authorization code back here.
app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Spotify authorization failed: ${error}`);
  }

  if (!code || !state || !oauthStates.has(state)) {
    return res.status(400).send("Invalid or expired Spotify authorization request.");
  }

  oauthStates.delete(state);

  try {
    validateEnvironment();

    const credentials = Buffer.from(
      `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
    ).toString("base64");

    const response = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: REDIRECT_URI
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
    tokenExpiresAt =
      Date.now() + Math.max((Number(response.data.expires_in) || 3600) - 60, 60) * 1000;

    // Spotify may return a replacement refresh token. Keep it in memory for
    // this running server. The original REFRESH_TOKEN environment variable
    // remains the persistent fallback after a server restart.
    if (response.data.refresh_token) {
      process.env.REFRESH_TOKEN = response.data.refresh_token;
    }

    return res.send(`
      <!doctype html>
      <html>
        <head><meta charset="utf-8"><title>Spotify Connected</title></head>
        <body style="font-family:system-ui;background:#121212;color:white;display:grid;place-items:center;min-height:100vh">
          <main style="text-align:center">
            <h1 style="color:#1db954">Spotify connected!</h1>
            <p>Your A-TrainBeatz backend is now authorized.</p>
            <p><a href="/now-playing" style="color:#1db954">Test /now-playing</a></p>
          </main>
        </body>
      </html>
    `);
  } catch (error) {
    console.error(
      "Spotify callback failed:",
      error.response?.data || error.message
    );

    return res.status(502).send("Spotify authorization could not be completed.");
  }
});


app.get("/health", (req, res) => {
  res.json({
    ok: true,
    spotifyTokenAvailable: Boolean(accessToken),
    tokenExpiresAt: tokenExpiresAt || null
  });
});

app.get("/player-token", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    res.set("Cache-Control", "no-store");
    return res.json({ access_token: token, expires_at: tokenExpiresAt });
  } catch (error) {
    console.error("Player token request failed:", error.message);
    return res.status(401).json({ error: "Spotify login required." });
  }
});

app.get("/now-playing", async (req, res) => {
  try {
    const token = await getValidAccessToken();

    const response = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        headers: {
          Authorization: `Bearer ${token}`
        },
        timeout: 15000,
        validateStatus: status => status >= 200 && status < 300
      }
    );

    // Spotify uses HTTP 204 when there is no active playback.
    if (response.status === 204 || !response.data) {
      return res.status(204).end();
    }

    return res.json(response.data);
  } catch (error) {
    const spotifyStatus = error.response?.status;
    const spotifyData = error.response?.data;

    console.error(
      "Error fetching now playing:",
      spotifyData || error.message
    );

    // A token can become invalid before our local expiry estimate.
    // Refresh once and retry the Spotify request.
    if (spotifyStatus === 401) {
      try {
        const newToken = await refreshAccessToken();

        const retry = await axios.get(
          "https://api.spotify.com/v1/me/player/currently-playing",
          {
            headers: {
              Authorization: `Bearer ${newToken}`
            },
            timeout: 15000,
            validateStatus: status => status >= 200 && status < 300
          }
        );

        if (retry.status === 204 || !retry.data) {
          return res.status(204).end();
        }

        return res.json(retry.data);
      } catch (retryError) {
        console.error(
          "Retry after token refresh failed:",
          retryError.response?.data || retryError.message
        );
      }
    }

    if (spotifyStatus === 403) {
      return res.status(403).json({
        error: "Spotify denied the request. Check that the Spotify account and API scopes are configured correctly."
      });
    }

    return res.status(502).json({
      error: "Failed to fetch now playing from Spotify."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Refresh before the token is likely to expire.
// The first request can also refresh it on demand, so startup is not race-prone.
refreshAccessToken().catch(() => {
  console.error("Initial Spotify token refresh failed.");
});

setInterval(() => {
  refreshAccessToken().catch(() => {
    console.error("Scheduled Spotify token refresh failed.");
  });
}, 50 * 60 * 1000);