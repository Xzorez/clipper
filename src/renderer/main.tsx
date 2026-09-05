import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installAudioCapture } from './lib/audioCapture';
import './styles/global.css';

// Fuera de React a proposito: la captura no depende de que haya nada pintado
// ni debe reiniciarse cada vez que la interfaz vuelva a renderizarse.
installAudioCapture();

const container = document.getElementById('root');
if (!container) throw new Error('No se ha encontrado el contenedor raiz');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
