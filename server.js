const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('querystring');
const crypto = require('crypto');

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

let access_token = '';
let refresh_token = '';
let token_expires_at = 0;

const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing'
].join(' ');

// ----------------------------------------------------
// Spotify OAuth login
// ----------------------------------------------------

app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');

  const params = qs.stringify({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state
  });

  res.redirect(
    'https://accounts.spotify.com/authorize?' + params
  );
});

// ----------------------------------------------------
// OAuth callback
// ----------------------------------------------------

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(
      `Spotify authorization failed: ${error}`
    );
  }

  if (!code) {
    return res.status(400).send(
      'No authorization code was provided.'
    );
  }

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      qs.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }),
      {
        headers: {
          Authorization:
            'Basic ' +
            Buffer
              .from(`${CLIENT_ID}:${CLIENT_SECRET}`)
              .toString('base64'),

          'Content-Type':
            'application/x-www-form-urlencoded'
        }
      }
    );

    access_token = response.data.access_token;

    // Spotify may not return a new refresh token
    // every time, so only replace it when supplied.
    if (response.data.refresh_token) {
      refresh_token = response.data.refresh_token;
    }

    token_expires_at =
      Date.now() + (response.data.expires_in * 1000);

    console.log('Spotify authorization successful.');

    res.send(`
      <html>
        <body>
          <h2>Spotify authorization successful!</h2>
          <p>You can close this tab.</p>
        </body>
      </html>
    `);

  } catch (err) {
    console.error(
      'Spotify token error:',
      err.response?.data || err.message
    );

    res.status(500).send(
      'Error during Spotify authorization.'
    );
  }
});

// ----------------------------------------------------
// Refresh access token
// ----------------------------------------------------

async function refreshAccessToken() {
  if (!refresh_token) {
    throw new Error('No Spotify refresh token available.');
  }

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    qs.stringify({
      grant_type: 'refresh_token',
      refresh_token
    }),
    {
      headers: {
        Authorization:
          'Basic ' +
          Buffer
            .from(`${CLIENT_ID}:${CLIENT_SECRET}`)
            .toString('base64'),

        'Content-Type':
          'application/x-www-form-urlencoded'
      }
    }
  );

  access_token = response.data.access_token;

  token_expires_at =
    Date.now() + (response.data.expires_in * 1000);

  // Spotify can issue a new refresh token.
  if (response.data.refresh_token) {
    refresh_token = response.data.refresh_token;
  }

  return access_token;
}

// ----------------------------------------------------
// Make sure the access token is valid
// ----------------------------------------------------

async function getValidAccessToken() {
  // Refresh 60 seconds before expiration.
  if (
    !access_token ||
    Date.now() >= token_expires_at - 60000
  ) {
    await refreshAccessToken();
  }

  return access_token;
}

// ----------------------------------------------------
// Manual refresh endpoint
// ----------------------------------------------------

app.get('/refresh', async (req, res) => {
  try {
    await refreshAccessToken();

    res.json({
      success: true
    });

  } catch (err) {
    console.error(
      'Refresh error:',
      err.response?.data || err.message
    );

    res.status(500).json({
      success: false,
      error: 'Failed to refresh Spotify access token.'
    });
  }
});

// ----------------------------------------------------
// Currently playing
// ----------------------------------------------------

app.get('/now-playing', async (req, res) => {
  try {
    const token = await getValidAccessToken();

    const response = await axios.get(
      'https://api.spotify.com/v1/me/player/currently-playing',
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    // Spotify can return 204 when nothing is currently playing.
    if (response.status === 204 || !response.data) {
      return res.status(204).send();
    }

    res.json(response.data);

  } catch (err) {
    console.error(
      'Now-playing error:',
      err.response?.data || err.message
    );

    if (err.response?.status === 401) {
      return res.status(401).json({
        error: 'Spotify authorization expired. Please log in again.'
      });
    }

    res.status(500).json({
      error: 'Failed to fetch now playing.'
    });
  }
});

// ----------------------------------------------------
// Playback state
// ----------------------------------------------------

app.get('/player', async (req, res) => {
  try {
    const token = await getValidAccessToken();

    const response = await axios.get(
      'https://api.spotify.com/v1/me/player',
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (response.status === 204 || !response.data) {
      return res.status(204).send();
    }

    res.json(response.data);

  } catch (err) {
    console.error(
      'Player error:',
      err.response?.data || err.message
    );

    res.status(500).json({
      error: 'Failed to fetch Spotify playback state.'
    });
  }
});

// ----------------------------------------------------
// Server
// ----------------------------------------------------

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});