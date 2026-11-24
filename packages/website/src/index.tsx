import { createRoot, hydrateRoot } from 'react-dom/client';
import './index.css';
import { App } from './components/App.tsx';

const root = document.getElementById('root');

if (root) {
  if (root.hasChildNodes()) hydrateRoot(root, <App />);
  else createRoot(root).render(<App />);
}
