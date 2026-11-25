import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './index.scss';
import { App } from './App';
import { ConsoleView } from './views/ConsoleView';
import { PopoutView } from './views/PopoutView';

const root = createRoot(document.getElementById('root')!);

const path = location.pathname;
const view = path === '/console' ? <ConsoleView />
  : path.startsWith('/popout/') ? <PopoutView />
  : <App />;

root.render(<React.StrictMode>{view}</React.StrictMode>);
