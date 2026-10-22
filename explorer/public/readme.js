(function () {
  const glyphs = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const finalText = 'THE KEY NEVER LEAVES';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const title = document.getElementById('decrypt');
  const memory = {};

  function readSeed(key) {
    try {
      const saved = localStorage.getItem(key);
      return saved == null ? undefined : saved;
    } catch (error) {
      return memory[key];
    }
  }

  function writeSeed(key, value) {
    memory[key] = value;
    try { localStorage.setItem(key, value); } catch (error) {}
  }

  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.storage || !window.chrome.storage.local) {
      window.chrome.storage = {
        local: {
          get(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (let i = 0; i < list.length; i++) out[list[i]] = readSeed(list[i]);
            return Promise.resolve(out);
          },
          set(obj) {
            const names = Object.keys(obj);
            for (let i = 0; i < names.length; i++) writeSeed(names[i], obj[names[i]]);
            return Promise.resolve();
          },
        },
      };
    }
  } catch (error) {}

  const origFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    const target = String(url);
    if (target.indexOf('https://rpc.clawdchain.trade') === 0) {
      return origFetch('/api/rpc', opts);
    }
    return origFetch(url, opts);
  };

  if (!title) return;
  if (reduce) {
    title.textContent = finalText;
    return;
  }

  let step = 0;
  const timer = window.setInterval(function () {
    step += 1;
    let out = '';
    for (let i = 0; i < finalText.length; i++) {
      const char = finalText.charAt(i);
      if (char === ' ') out += ' ';
      else if (i < step) out += char;
      else out += glyphs.charAt(Math.floor(Math.random() * glyphs.length));
    }
    title.textContent = out;
    if (step >= finalText.length) window.clearInterval(timer);
  }, 42);

  const canvas = document.getElementById('rain');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let columns = [];
  let width = 0;
  let height = 0;

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.max(1, Math.ceil(width / 18));
    columns = [];
    for (let i = 0; i < count; i++) {
      columns.push({
        y: Math.random() * height,
        speed: 12 + Math.random() * 28,
        glyph: glyphs.charAt(Math.floor(Math.random() * glyphs.length)),
        hot: Math.random() < 0.08,
      });
    }
  }

  let last = 0;
  function frame(now) {
    const dt = Math.min(48, now - last || 16);
    last = now;
    ctx.fillStyle = 'rgba(7,6,13,0.14)';
    ctx.fillRect(0, 0, width, height);
    ctx.font = '15px "IBM Plex Mono", ui-monospace, monospace';
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      ctx.fillStyle = col.hot ? '#ff3b5c' : 'rgba(182,255,59,0.9)';
      ctx.fillText(col.glyph, i * 18, col.y);
      col.y += col.speed * dt / 1000;
      if (Math.random() < 0.08) col.glyph = glyphs.charAt(Math.floor(Math.random() * glyphs.length));
      if (col.y > height + 20) {
        col.y = -20;
        col.hot = Math.random() < 0.08;
      }
    }
    const scan = (now / 18) % (height + 40) - 20;
    ctx.fillStyle = 'rgba(182,255,59,0.05)';
    ctx.fillRect(0, scan, width, 18);
    window.requestAnimationFrame(frame);
  }

  size();
  window.addEventListener('resize', size);
  window.requestAnimationFrame(frame);
})();
