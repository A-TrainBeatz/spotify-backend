const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");
const crypto = require("crypto");

dotenv.config();

const app = express();
app.use(cors({
  origin: true,
  methods: ["GET", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept", "Authorization"]
}));
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://127.0.0.1:${PORT}`
).replace(/\/$/, "");

const REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || `${BASE_URL}/callback`;

const OAUTH_SCOPE =
  "streaming user-read-currently-playing user-read-playback-state user-modify-playback-state";

const oauthStates = new Set();

let accessToken = "";
let tokenExpiresAt = 0;
let refreshToken = process.env.REFRESH_TOKEN || "";
let refreshPromise = null;

function validateEnvironment() {
  const required = ["CLIENT_ID", "CLIENT_SECRET"];
  const missing = required.filter(name => !process.env[name]);

  if (!refreshToken) missing.push("REFRESH_TOKEN");

  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}`
    );
  }
}

async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;

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
          refresh_token: refreshToken
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
        Date.now() +
        Math.max((Number(response.data.expires_in) || 3600) - 60, 60) * 1000;

      if (response.data.refresh_token) {
        refreshToken = response.data.refresh_token;
      }

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
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  return refreshAccessToken();
}

async function spotifyRequest(method, url, options = {}, retry = true) {
  const token = await getValidAccessToken();

  try {
    return await axios({
      method,
      url,
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`
      },
      timeout: 15000
    });
  } catch (error) {
    if (retry && error.response?.status === 401) {
      const newToken = await refreshAccessToken();

      return axios({
        method,
        url,
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${newToken}`
        },
        timeout: 15000
      });
    }

    throw error;
  }
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "spotify-backend",
    endpoints: [
      "/login",
      "/callback",
      "/now-playing",
      "/player-token",
      "/transfer-playback",
      "/health"
    ]
  });
});

app.get("/login", (req, res) => {
  try {
    validateEnvironment();

    const state = crypto.randomBytes(24).toString("hex");
    oauthStates.add(state);

    // Prevent unbounded state growth.
    setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);

    const authUrl = new URL("https://accounts.spotify.com/authorize");
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: process.env.CLIENT_ID,
      scope: OAUTH_SCOPE,
      redirect_uri: REDIRECT_URI,
      state
    }).toString();

    res.redirect(authUrl.toString());
  } catch (error) {
    console.error("Unable to start Spotify login:", error.message);
    res.status(500).send(
      "Spotify login is not configured correctly on the server."
    );
  }
});

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Spotify authorization failed: ${error}`);
  }

  if (!code || !state || !oauthStates.has(state)) {
    return res.status(400).send(
      "Invalid or expired Spotify authorization request."
    );
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

    accessToken = response.data.access_token;
    tokenExpiresAt =
      Date.now() +
      Math.max((Number(response.data.expires_in) || 3600) - 60, 60) * 1000;

    if (response.data.refresh_token) {
      refreshToken = response.data.refresh_token;
    }

    res.send(`
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Spotify Connected</title>
        </head>
        <body style="font-family:system-ui;background:#121212;color:#fff;display:grid;place-items:center;min-height:100vh">
          <main style="text-align:center">
            <h1 style="color:#1db954">Spotify connected!</h1>
            <p>A-TrainBeatz is authorized.</p>
            <p><a href="https://a-trainbeatz.github.io/" style="color:#1db954">Open A-TrainBeatz</a></p>
          </main>
        </body>
      </html>
    `);
  } catch (error) {
    console.error(
      "Spotify callback failed:",
      error.response?.data || error.message
    );
    res.status(502).send("Spotify authorization could not be completed.");
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
    res.json({
      access_token: token,
      expires_at: tokenExpiresAt
    });
  } catch (error) {
    console.error("Player token request failed:", error.message);
    res.status(401).json({ error: "Spotify login required." });
  }
});

app.get("/now-playing", async (req, res) => {
  try {
    const response = await spotifyRequest(
      "GET",
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        validateStatus: status =>
          (status >= 200 && status < 300) || status === 204
      }
    );

    if (response.status === 204 || !response.data) {
      return res.status(204).end();
    }

    res.json(response.data);
  } catch (error) {
    const status = error.response?.status;

    console.error(
      "Error fetching now playing:",
      error.response?.data || error.message
    );

    if (status === 403) {
      return res.status(403).json({
        error:
          "Spotify denied the request. Check the account and OAuth scopes."
      });
    }

    res.status(502).json({
      error: "Failed to fetch now playing from Spotify."
    });
  }
});

app.put("/transfer-playback", async (req, res) => {
  const {
    device_id: deviceId,
    track_uri: trackUri,
    position_ms: requestedPosition,
    play = true
  } = req.body || {};

  if (!deviceId) {
    return res.status(400).json({ error: "device_id is required." });
  }

  try {
    const body = {};

    // If a track URI is provided, start that exact track at the supplied
    // timestamp. Otherwise transfer the existing Spotify playback context.
    if (trackUri) {
      body.uris = [String(trackUri)];
      body.position_ms = Math.max(
        0,
        Math.floor(Number(requestedPosition) || 0)
      );
    }

    body.play = Boolean(play);

    const response = await spotifyRequest(
      "PUT",
      "https://api.spotify.com/v1/me/player",
      {
        params: { device_ids: JSON.stringify([String(deviceId)]) },
        data: body,
        headers: { "Content-Type": "application/json" }
      }
    );

    res.status(response.status === 204 ? 204 : 200).end();
  } catch (error) {
    console.error(
      "Playback transfer failed:",
      error.response?.data || error.message
    );

    const status = error.response?.status;

    if (status === 403) {
      return res.status(403).json({
        error:
          "Spotify denied playback control. Make sure the user granted user-modify-playback-state and has Spotify Premium."
      });
    }

    if (status === 404) {
      return res.status(404).json({
        error: "Spotify playback device was not found."
      });
    }

    res.status(502).json({
      error: "Could not transfer Spotify playback."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Spotify redirect URI: ${REDIRECT_URI}`);
});

refreshAccessToken().catch(() => {
  console.error("Initial Spotify token refresh failed.");
});

setInterval(() => {
  refreshAccessToken().catch(() => {
    console.error("Scheduled Spotify token refresh failed.");
  });
}, 50 * 60 * 1000);
