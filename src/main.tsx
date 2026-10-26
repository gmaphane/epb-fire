import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { App } from './ui/App';
import { startApp } from './boot';
import { setState } from './core/store';

const updateSW = registerSW({
  onNeedRefresh() {
    setState({ updateReady: () => void updateSW(true) });
  },
});

render(<App />, document.getElementById('app')!);
void startApp();
