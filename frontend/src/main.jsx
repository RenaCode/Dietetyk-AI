// Touch to trigger CI rebuild
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { installSsoFetchGuard } from './utils/sso';

// Before the first render, so every fetch the app makes goes through it - see utils/sso.js.
installSsoFetchGuard();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
