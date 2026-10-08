const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");
const crypto = require("crypto");

dotenv.config();

const app = express();
app.use(cors());

const PORT = Number(process.env.PORT) || 3000;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI =
  process.env.REDIRECT_URI ||
  (process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/callback`
    : `http://127.0.0.1:${PORT}/callback`);

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_URL = "https://api.spotify.com/v1/me/player";

const SCOPES = "user-read-currently-playing user-read-playback-state";

let accessToken = "";
let tokenExpiresAt = 0;
let refreshPromise = null;

function validateEnvironment() {
  const required = ["CLIENT_ID", "CLIENT_SECRET"];
  const missing = required.filter(name => !process.env[name]);

  if (missing.length) {
    console.warn(`Missing environment variables: ${missing.join(", ")}`);
    return false;
  }

  return true;
}

function getBasicAuth() {
  return Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
}

// ---------------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------------

app.get("/login", (req, res) => {
  if (!validateEnvironment()) {
    return res.status(500).send("CLIENT_ID and CLIENT_SECRET must be configured.");
  }

  // State protects the OAuth callback from CSRF.
  const state = crypto.randomBytes(24).toString("hex");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    show_dialog: "true"
  });

  // Store the state in a short-lived cookie without requiring another package.
  res.setHeader(
    "Set-Cookie",
    `spotify_oauth_state=${state}; Max-Age=600; HttpOnly; Secure; SameSite=Lax; Path=/`
  );

  console.log(`Starting Spotify login. Redirect URI: ${REDIRECT_URI}`);
  res.redirect(`${AUTH_URL}?${params.toString()}`);
});

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const cookies = Object.fromEntries(
    header.split(";").filter(Boolean).map(part => {
      const index = part.indexOf("=");
      return [
        part.slice(0, index).trim(),
        decodeURIComponent(part.slice(index + 1).trim())
      ];
    })
  );
  return cookies[name];
}

// ---------------------------------------------------------------------------
// OAUTH CALLBACK
// ---------------------------------------------------------------------------

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Spotify authorization failed: ${error}`);
  }

  if (!code) {
    return res.status(400).send("Authorization code missing from query parameters.");
  }

  const savedState = getCookie(req, "spotify_oauth_state");

  if (!state || !savedState || state !== savedState) {
    return res.status(400).send("Invalid OAuth state. Please visit /login again.");
  }

  try {
    const response = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code"
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${getBasicAuth()}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        timeout: 15000
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;

    if (!access_token) {
      throw new Error("Spotify did not return an access token.");
    }

    accessToken = access_token;
    tokenExpiresAt = Date.now() + Math.max(Number(expires_in || 3600) - 60, 60) * 1000;

    console.log("Spotify authorization successful.");

    // A refresh token is only returned when Spotify issues one.
    // Keep the existing environment token if Spotify does not return a replacement.
    if (refresh_token) {
      console.log("\n=============================================");
      console.log("NEW SPOTIFY REFRESH TOKEN:");
      console.log(refresh_token);
      console.log("=============================================\n");
    }

    res.send(`
      <!doctype html>
      <html>
      <head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:system-ui;background:#121212;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px">
        <main style="background:#1e1e1e;padding:32px;border-radius:16px;max-width:600px;text-align:center">
          <h1 style="color:#1db954">Spotify Login Successful</h1>
          <p>Your server is now authorized to read the currently playing track.</p>
          ${
            refresh_token
              ? `<p style="color:#bbb">A new refresh token was generated. Copy it from the server logs and save it as <code>REFRESH_TOKEN</code> in Render if you want the server to remain authorized after this session.</p>`
              : `<p style="color:#bbb">No new refresh token was returned. The current server session is authorized.</p>`
          }
          <p><a href="/now-playing" style="color:#1db954">Test Now Playing</a></p>
        </main>
      </body>
      </html>
    `);
  } catch (error) {
    console.error(
      "Error exchanging authorization code:",
      error.response?.data || error.message
    );
    res.status(500).send("Authentication failed. Check the server logs.");
  }
});

// ---------------------------------------------------------------------------
// ACCESS TOKEN MANAGEMENT
// ---------------------------------------------------------------------------

async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      if (!validateEnvironment() || !process.env.REFRESH_TOKEN) {
        throw new Error("REFRESH_TOKEN is not configured.");
      }

      const response = await axios.post(
        TOKEN_URL,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: process.env.REFRESH_TOKEN
        }).toString(),
        {
          headers: {
            Authorization: `Basic ${getBasicAuth()}`,
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

// ---------------------------------------------------------------------------
// API ROUTES
// ---------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "spotify-backend",
    login: "/login",
    nowPlaying: "/now-playing"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    spotifyTokenAvailable: Boolean(accessToken),
    tokenExpiresAt
  });
});

app.get("/now-playing", async (req, res) => {
  let token;

  try {
    token = await getValidAccessToken();
  } catch (error) {
    return res.status(401).json({
      error: "spotify_login_required",
      message: "Visit /login to authorize Spotify."
    });
  }

  try {
    const response = await axios.get(API_URL, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
      validateStatus: status => status >= 200 && status < 300
    });

    if (response.status === 204 || !response.data?.item) {
      return res.status(204).end();
    }

    return res.json(response.data);
  } catch (error) {
    const spotifyStatus = error.response?.status;

    if (spotifyStatus === 401) {
      try {
        const newToken = await refreshAccessToken();
        const retry = await axios.get(API_URL, {
          headers: { Authorization: `Bearer ${newToken}` },
          timeout: 15000
        });

        if (retry.status === 204 || !retry.data?.item) {
          return res.status(204).end();
        }

        return res.json(retry.data);
      } catch (retryError) {
        return res.status(401).json({
          error: "spotify_login_required",
          message: "Spotify authorization expired. Visit /login again."
        });
      }
    }

    if (spotifyStatus === 403) {
      return res.status(403).json({
        error: "spotify_denied",
        message: "Spotify denied access. Check the app permissions and account."
      });
    }

    console.error(
      "Now Playing API error:",
      error.response?.data || error.message
    );

    return res.status(502).json({
      error: "spotify_api_failed",
      message: "Failed to fetch data from Spotify."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Spotify redirect URI: ${REDIRECT_URI}`);
});

// If REFRESH_TOKEN already exists, load it immediately.
// Otherwise the server still starts normally and /login performs authorization.
if (process.env.REFRESH_TOKEN) {
  refreshAccessToken().catch(() => {
    console.log("Stored refresh token could not be loaded. Visit /login to authorize again.");
  });
} else {
  console.log("No REFRESH_TOKEN configured. Visit /login to authorize Spotify.");
}

setInterval(() => {
  if (process.env.REFRESH_TOKEN) {
    refreshAccessToken().catch(() => {});
  }
}, 50 * 60 * 1000);
