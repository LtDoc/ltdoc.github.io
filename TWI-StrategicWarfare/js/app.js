import { checkDevIP } from './auth.js';
import { initUI } from './ui.js';
import { initMap } from './map.js';

(async () => {
  const isDev = await checkDevIP();
  initMap(isDev);
  initUI(isDev);
})();
