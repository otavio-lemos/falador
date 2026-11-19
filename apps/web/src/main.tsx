// main.tsx — boot + baseline SCSS do Carbon React (tema g100 aplicado no App via <Theme>).
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './index.scss';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
