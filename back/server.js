// Dummy backend server file for testing GitHub Actions labeler
// This file is created to test that the labeler correctly applies
// the 'back' label when files in the back/ folder are modified

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ message: 'Hello from the backend!' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = app;
