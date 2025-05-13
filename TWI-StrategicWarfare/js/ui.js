import {
    watchList,
    addItem,
    updateItem,
    removeItem,
    fetchOnce
  } from './data.js';
  import { uploadFile } from './firebase.js';
  import { addUnitFromTemplate } from './map.js';
  
  export async function initUI(isDev) {
    document.body.classList.remove('hidden');
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('toggleSidebar');
  
    toggleBtn.addEventListener('click', () =>
      sidebar.classList.toggle('hidden')
    );
  
    if (!isDev) {
      sidebar.classList.add('hidden');
      toggleBtn.classList.add('hidden');
      return;
    }
  
    await setupNations();
    await setupTemplates();
    setupAddUnit();
  }
  
  async function setupNations() {
    const listEl = document.getElementById('nationList');
    const selectEl = document.getElementById('unitNation');
  
    watchList('nations', nations => {
      listEl.innerHTML = '';
      selectEl.innerHTML = '<option value="">-- Nation --</option>';
      nations.forEach(n => {
        const li = document.createElement('li');
        li.textContent = n.name;
        const btn = document.createElement('button');
        btn.textContent = '×';
        btn.onclick = () => removeItem('nations', n.id);
        li.append(btn);
        listEl.append(li);
  
        const opt = document.createElement('option');
        opt.value = n.id;
        opt.textContent = n.name;
        selectEl.append(opt);
      });
    });
  
    const form = document.getElementById('nationForm');
    form.onsubmit = async e => {
      e.preventDefault();
      const name = document.getElementById('nationName').value.trim();
      const file = document.getElementById('nationFlag').files[0];
      if (!name || !file) return;
      // create placeholder
      const key = addItem('nations', { name: '', flagUrl: '' });
      const url = await uploadFile(`nations/${key}`, file);
      updateItem('nations', key, { name, flagUrl: url });
      form.reset();
    };
  }
  
  async function setupTemplates() {
    const listEl = document.getElementById('templateList');
    const selectEl = document.getElementById('unitTemplate');
    const preview = document.getElementById('templatePreview');
  
    watchList('unitTemplates', templates => {
      listEl.innerHTML = '';
      selectEl.innerHTML = '<option value="">-- select --</option>';
      templates.forEach(tpl => {
        const li = document.createElement('li');
        li.textContent = tpl.name;
        const btn = document.createElement('button');
        btn.textContent = '×';
        btn.onclick = () => removeItem('unitTemplates', tpl.id);
        li.append(btn);
        listEl.append(li);
  
        const opt = document.createElement('option');
        opt.value = tpl.id;
        opt.textContent = tpl.name;
        selectEl.append(opt);
      });
    });
  
    const form = document.getElementById('templateForm');
    form.onsubmit = async e => {
      e.preventDefault();
      const name = document.getElementById('tplName').value.trim();
      const file = document.getElementById('tplIcon').files[0];
      const attack = parseInt(document.getElementById('tplAttack').value) || 0;
      const defence = parseInt(document.getElementById('tplDefence').value) || 0;
      const ap = parseInt(document.getElementById('tplAP').value) || 0;
      const range = parseInt(document.getElementById('tplRange').value) || 0;
      const action1 = document.getElementById('tplAction1').value;
      const action2 = document.getElementById('tplAction2').value;
      const action3 = document.getElementById('tplAction3').value;
      const ability = document.getElementById('tplAbility').value;
      const notes = document.getElementById('tplNotes').value;
      if (!name || !file) return;
  
      const key = addItem('unitTemplates', {
        name: '',
        iconUrl: '',
        attack: 0,
        defence: 0,
        ap: 0,
        range: 0,
        action1: '',
        action2: '',
        action3: '',
        ability: '',
        notes: ''
      });
      const url = await uploadFile(`unitTemplates/${key}`, file);
      updateItem('unitTemplates', key, {
        name,
        iconUrl: url,
        attack,
        defence,
        ap,
        range,
        action1,
        action2,
        action3,
        ability,
        notes
      });
      form.reset();
    };
  
    selectEl.onchange = async () => {
      const id = selectEl.value;
      if (!id) {
        preview.src = '';
        document.getElementById('unitName').value = '';
        return;
      }
      const tpl = await fetchOnce(`unitTemplates/${id}`);
      preview.src = tpl.iconUrl || '';
      document.getElementById('unitName').value = tpl.name || '';
    };
  }
  
  function setupAddUnit() {
    document.getElementById('addUnit').onclick = async () => {
      const tplId = document.getElementById('unitTemplate').value;
      const name  = document.getElementById('unitName').value;
      const nation= document.getElementById('unitNation').value;
      if (!tplId || !nation) return;
      await addUnitFromTemplate(tplId, name, nation);
    };
  }
  