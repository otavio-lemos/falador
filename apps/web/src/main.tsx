import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './index.scss';
import { App } from './App';
import { ConsoleView } from './views/ConsoleView';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    {location.pathname === '/console' ? <ConsoleView /> : <App />}
  </React.StrictMode>,
);
