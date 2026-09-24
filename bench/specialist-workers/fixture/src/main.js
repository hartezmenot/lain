import { getMe, getSettings, saveSettings } from './api.js';
import { renderUser } from './user.js';
import { toast } from './components/toast.js';

const $ = (id) => document.getElementById(id);

async function boot() {
  console.log('[boot] starting TeamDesk', new Date().toISOString());
  const me = await getMe();
  console.log('[boot] me =', JSON.stringify(me));
  renderUser(me);

  const s = await getSettings();
  console.log('[boot] settings =', JSON.stringify(s));
  $('wsName').value = s.workspaceName;
  $('digest').value = s.digest;

  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('status').textContent = 'Saving…';
    try {
      const saved = await saveSettings({ workspaceName: $('wsName').value, digest: $('digest').value });
      $('status').textContent = 'Saved';
      $('wsName').value = saved.workspaceName;
      toast('Settings saved 🎉');
    } catch (err) {
      $('status').textContent = 'Could not save';
    }
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    $('note').value = '';
  });
}

boot();
