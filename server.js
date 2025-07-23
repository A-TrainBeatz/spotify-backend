const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();
const app = express();
app.use(cors());

let accessToken = ''; // Global variable to hold the current token

// Function to refresh token
async function refreshAccessToken() {
  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: process.env.REFRESH_TOKEN,
      }),
      {
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(process.env.CLIENT_ID + ':' + process.env.CLIENT_SECRET).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    accessToken = response.data.access_token;
    console.log('Access token refreshed at', new Date().toLocaleTimeString());
  } catch (error) {
    console.error('Error refreshing token:', error.response?.data || error.message);
  }
}

// Immediately refresh once on server start
refreshAccessToken();

// Refresh every 15 minutes
setInterval(refreshAccessToken, 15 * 60 * 1000);

// Your `/now-playing` endpoint
app.get('/now-playing', async (req, res) => {
  try {
    const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching now playing:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch now playing' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
