import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { defineFocusTrap } from './customElements/FocusTrap';
import AppProvider from './data/AppProvider';
import App from './ui/App';

defineFocusTrap();

const rootElement = document.getElementsByTagName('main')[0];

rootElement &&
  createRoot(rootElement).render(
    <StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </StrictMode>
  );

IS_DEVELOPMENT && new EventSource('/esbuild').addEventListener('change', () => location.reload());
