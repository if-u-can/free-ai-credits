(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EggInteractions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KEY = 'freeegg.eaten.v1';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const date = value => value ? String(value).slice(0, 10) : '未记录';
  function createStore(options = {}) {
    const storage = options.storage, request = options.fetch;
    const eaten = new Set(), records = new Map(), busy = new Set(), messages = new Map(), revisions = new Map();
    const listeners = new Set();
    let available = false, loading = false, serviceMessage = '正在检查投票服务…', storageMessage = '', siteKey = '';
    try {
      const raw = storage?.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (!Array.isArray(saved) || !saved.every(id => typeof id === 'string')) throw Error('damaged');
        saved.forEach(id => eaten.add(id));
      }
    } catch (error) { storageMessage = error instanceof SyntaxError || error.message === 'damaged' ? '吃过记录已损坏，已重新开始记录。' : '浏览器拒绝保存，吃过记录仅在当前页面有效。'; }
    const emit = () => listeners.forEach(fn => fn());
    function view(egg) {
      const record = records.get(egg.id);
      return { good: available && record ? record.good : null, bad: available && record ? record.bad : null,
        myVote: record?.myVote || null, busy: busy.has(egg.id), eaten: eaten.has(egg.id),
        reviewPending: !!record?.reviewPending, reviewRequestedAt: record?.reviewRequestedAt,
        lastVerified: record?.lastVerified || egg.verified_at, message: messages.get(egg.id) || '' };
    }
    function cardHTML(egg) {
      const v = view(egg), disabled = !available || v.busy;
      const button = (vote, label) => '<button type="button" class="egg-action vote-' + vote + '" data-egg-action="' + vote + '" aria-label="' + escape(egg.name + '：' + label) + '" aria-pressed="' + (v.myVote === vote) + '"' + (disabled ? ' disabled' : '') + '><img src="./assets/interactions/' + vote + '-egg.webp" alt="" width="32" height="32"><span>' + label + '<b class="vote-count">' + (v[vote] ?? '—') + '</b></span></button>';
      return '<div class="egg-interaction" data-egg-id="' + escape(egg.id) + '"><div class="egg-actions">' + button('good', '好鸡蛋') + button('bad', '坏鸡蛋') + '<button type="button" class="egg-action eaten-action" data-egg-action="eaten" aria-label="' + escape(egg.name + '：记录是否吃过') + '" aria-pressed="' + v.eaten + '"><img src="./assets/interactions/' + (v.eaten ? 'eaten' : 'uneaten') + '-egg.webp" alt="" width="32" height="32"><span class="eaten-label">' + (v.eaten ? '吃过' : '没吃过') + '</span></button></div><p class="egg-review-state">' + (v.reviewPending ? '待复核 · ' : '') + '最近核实 ' + escape(date(v.lastVerified)) + '</p><p class="egg-action-message" role="status" aria-live="polite">' + escape(v.message) + '</p></div>';
    }
    function toggleEaten(id) {
      eaten.has(id) ? eaten.delete(id) : eaten.add(id);
      try { if (!storage) throw Error(); storage.setItem(KEY, JSON.stringify([...eaten])); storageMessage = ''; }
      catch { storageMessage = '浏览器拒绝保存，吃过记录仅在当前页面有效。'; }
      emit();
    }
    async function load(eggs) {
      if (loading || busy.size) return false;
      loading = true; serviceMessage = '正在检查投票服务…'; emit();
      try {
        const configResponse = await request('./api/interactions/config', { cache: 'no-store' });
        const config = await configResponse.json();
        if (!configResponse.ok || !config.available) throw Error();
        siteKey = config.turnstileSiteKey || '';
        const snapshot = new Map(revisions);
        const response = await request('./api/interactions?ids=' + encodeURIComponent(eggs.map(e => e.id).join(',')), { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.available || !data.eggs) throw Error();
        for (const egg of eggs) if ((revisions.get(egg.id) || 0) === (snapshot.get(egg.id) || 0) && data.eggs[egg.id]) records.set(egg.id, data.eggs[egg.id]);
        available = true; serviceMessage = '每人每颗鸡蛋一票，可以改票。';
      } catch { available = false; serviceMessage = '投票暂不可用，请稍后重试。吃过记录仍可使用。'; }
      finally { loading = false; emit(); }
      return available;
    }
    async function vote(id, voteValue, tokenProvider) {
      if (!available || loading || busy.has(id)) return false;
      busy.add(id); messages.set(id, '正在提交…'); revisions.set(id, (revisions.get(id) || 0) + 1); emit();
      try {
        const token = siteKey ? await tokenProvider(siteKey) : '';
        const response = await request('./api/interactions/vote', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ eggId: id, vote: voteValue, ...(token ? { turnstileToken: token } : {}) }) }).catch(() => {
          available = false; serviceMessage = '投票暂不可用，请稍后重试。吃过记录仍可使用。';
          throw Error('网络连接失败，投票尚未提交，请重试。');
        });
        const data = await response.json();
        if (!response.ok || !data.available || data.egg?.id !== id) {
          if (response.status === 503) { available = false; serviceMessage = '投票暂不可用，请稍后重试。吃过记录仍可使用。'; }
          throw Error(data.message || '投票没有成功，请重试。');
        }
        records.set(id, data.egg); messages.set(id, '已记录你的' + (voteValue === 'good' ? '好鸡蛋' : '坏鸡蛋') + '反馈。');
        return true;
      } catch (error) { messages.set(id, error.message || '网络连接失败，投票没有成功，请重试。'); return false; }
      finally { busy.delete(id); emit(); }
    }
    return { view, cardHTML, toggleEaten, load, vote, isEaten: id => eaten.has(id),
      matches: (egg, filter = 'all') => filter === 'all' || (filter === 'eaten' ? eaten.has(egg.id) : !eaten.has(egg.id)),
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      get available() { return available; }, get loading() { return loading; },
      get serviceMessage() { return serviceMessage; }, get storageMessage() { return storageMessage; } };
  }
  function mount({ getEggs, render }) {
    let local;
    try { local = window.localStorage; } catch { local = { getItem() { throw Error(); }, setItem() { throw Error(); } }; }
    const store = createStore({ storage: local, fetch: window.fetch.bind(window) });
    let eatenFilter = 'all', captchaScript;
    const cards = document.querySelector('#cards');
    const panel = document.querySelector('#interaction-service');
    function updateDom() {
      cards.querySelectorAll('.egg-interaction').forEach(block => {
        const egg = getEggs().find(e => e.id === block.dataset.eggId); if (!egg) return;
        const v = store.view(egg);
        for (const vote of ['good', 'bad']) {
          const button = block.querySelector('[data-egg-action="' + vote + '"]');
          button.disabled = !store.available || store.loading || v.busy;
          button.setAttribute('aria-pressed', String(v.myVote === vote));
          button.setAttribute('aria-label', egg.name + '：' + (vote === 'good' ? '好鸡蛋' : '坏鸡蛋') + '，' + (v[vote] === null ? '票数暂不可用' : v[vote] + ' 票'));
          button.querySelector('.vote-count').textContent = v[vote] ?? '—';
        }
        const eatenButton = block.querySelector('[data-egg-action="eaten"]');
        eatenButton.setAttribute('aria-pressed', String(v.eaten));
        eatenButton.querySelector('img').src = './assets/interactions/' + (v.eaten ? 'eaten' : 'uneaten') + '-egg.webp';
        eatenButton.querySelector('.eaten-label').textContent = v.eaten ? '吃过' : '没吃过';
        block.querySelector('.egg-review-state').textContent = (v.reviewPending ? '待复核 · ' : '') + '最近核实 ' + date(v.lastVerified);
        block.querySelector('.egg-action-message').textContent = v.message;
      });
      panel.querySelector('.interaction-service-message').textContent = store.serviceMessage;
      panel.querySelector('.interaction-storage-message').textContent = store.storageMessage;
      panel.querySelector('[data-interaction-retry]').hidden = store.available;
      panel.querySelector('[data-interaction-retry]').disabled = store.loading;
      const pending = getEggs().filter(egg => store.view(egg).reviewPending);
      document.querySelector('#review-count').textContent = store.available ? '待复核 ' + pending.length + ' 颗' : '复核名单暂不可用';
      document.querySelector('#review-list').innerHTML = pending.length ? pending.map(egg => '<li>' + escape(egg.name) + '</li>').join('') : '';
    }
    function tokenProvider(sitekey) {
      const dialog = document.querySelector('#vote-verification');
      const box = dialog.querySelector('.vote-captcha');
      dialog.showModal();
      dialog.querySelector('.captcha-message').textContent = '完成验证后，这次投票才会提交。';
      return new Promise((resolve, reject) => {
        let widget = null, finished = false;
        const cleanup = () => { dialog.removeEventListener('close', cancel); if (widget !== null && window.turnstile) window.turnstile.remove(widget); box.replaceChildren(); if (dialog.open) dialog.close(); };
        const finish = (error, token) => { if (finished) return; finished = true; cleanup(); error ? reject(error) : resolve(token); };
        const cancel = () => finish(Error('验证已取消，投票尚未提交。'));
        dialog.addEventListener('close', cancel);
        if (!captchaScript) captchaScript = new Promise((ready, failed) => {
          if (window.turnstile) return ready();
          const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true;
          script.onload = ready; script.onerror = () => { captchaScript = null; failed(Error('验证加载失败，请重试。')); }; document.head.appendChild(script);
        });
        captchaScript.then(() => { if (finished) return; widget = window.turnstile.render(box, { sitekey, action: 'egg-vote', callback: token => finish(null, token), 'error-callback': () => finish(Error('验证失败，请重试。')), 'expired-callback': () => finish(Error('验证已过期，请重试。')) }); }).catch(error => finish(error));
      });
    }
    cards.addEventListener('click', event => {
      const button = event.target.closest('[data-egg-action]'); if (!button || button.disabled) return;
      const id = button.closest('[data-egg-id]').dataset.eggId;
      if (button.dataset.eggAction === 'eaten') { store.toggleEaten(id); if (eatenFilter !== 'all') render(); }
      else store.vote(id, button.dataset.eggAction, tokenProvider);
    });
    document.querySelectorAll('[data-eaten-filter]').forEach(button => button.addEventListener('click', () => {
      eatenFilter = button.dataset.eatenFilter;
      document.querySelectorAll('[data-eaten-filter]').forEach(other => { const selected = other === button; other.classList.toggle('active', selected); other.setAttribute('aria-pressed', String(selected)); });
      render();
    }));
    panel.querySelector('[data-interaction-retry]').addEventListener('click', () => store.load(getEggs()));
    store.subscribe(updateDom); updateDom();
    return { cardHTML: store.cardHTML, matches: egg => store.matches(egg, eatenFilter), updateDom, load: eggs => store.load(eggs) };
  }
  return { createStore, mount };
});
