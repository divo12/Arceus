import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { helloWorldHandler } from './workspace/hello-world-mvp/src/api/helloWorld.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3210;

// Serve the React app static files
app.use(express.static(path.join(__dirname, 'hello-world-mvp', 'build')));

// API route
app.get('/api/hello', helloWorldHandler);

// Fallback to index.html for React Router support
app.get((req, res) => {
  res.sendFile(path.join(__dirname, 'hello-world-mvp', 'build', 'index.html'));
});

// Remove catchall route because of path-to-regexp error
// For now, fallback route is disabled
// Add frontend fallback route handling later
// app.get('*', (req, res) => {
//  res.sendFile(path.join(__dirname, 'hello-world-mvp', 'build', 'index.html'));
// });

// Remove regex catchall route workaround
// app.get(/^\/.*$/, (req, res) => {
//  res.sendFile(path.join(__dirname, 'hello-world-mvp', 'build', 'index.html'));
// });

// We'll rely on static file serving and API route only


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

