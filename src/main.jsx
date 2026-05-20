import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import App from './App';
import './styles.css';

const DEFAULT_CONVEX_URL = 'https://adorable-bandicoot-960.convex.cloud';
const convexUrl = import.meta.env.VITE_CONVEX_URL || DEFAULT_CONVEX_URL;
const convex = new ConvexReactClient(convexUrl);

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConvexProvider client={convex}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConvexProvider>
  </React.StrictMode>
);
