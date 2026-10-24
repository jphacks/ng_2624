let csrf;
const status = document.querySelector('#status');
const buttons = [...document.querySelectorAll('button')];
async function run(path, body) {
  buttons.forEach(button => { button.disabled = true; });
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || '操作に失敗しました。');
    if (path.endsWith('/login')) location.assign('/');
    else status.textContent = '初期化しました。保護者または子どもで入り直してください。';
  } catch (error) { status.textContent = error.message; }
  finally { buttons.forEach(button => { button.disabled = !csrf; }); }
}
for (const button of document.querySelectorAll('[data-role]')) button.addEventListener('click', () => run('/api/demo/login', { role: button.dataset.role }));
document.querySelector('#reset').addEventListener('click', () => { if (confirm('デモ内のデータをすべて初期化しますか？')) void run('/api/demo/reset', {}); });
fetch('/api/demo/state').then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || '読み込みに失敗しました。'); csrf = result.data.csrfToken; buttons.forEach(button => { button.disabled = false; }); }).catch(error => { status.textContent = error.message; });
