// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyCo9QPVrLCXS6li_kcTu3e-GOoiiwpHvLs",
    authDomain: "woe-world.firebaseapp.com",
    databaseURL: "https://woe-world-default-rtdb.firebaseio.com",
    projectId: "woe-world",
    storageBucket: "woe-world.appspot.com",
    messagingSenderId: "706865712365",
    appId: "1:706865712365:web:e080b1ef45b8d8b27190e4",
    measurementId: "G-789BN2WECG"
};
firebase.initializeApp(firebaseConfig);
const database = firebase.database();
const storage = firebase.storage();

// Elements
const characterForm = document.getElementById('character-form');
const characterDisplay = document.getElementById('character-display');
const savePngButton = document.getElementById('savePng');
const rollBtns = document.querySelectorAll('.roll-btn');
const characterIdDisplay = document.getElementById('character-id-display');
const characterPortrait = document.getElementById('character-portrait');

// Populate select fields with data
document.addEventListener('DOMContentLoaded', () => {
    populateSelect('class', data.classes);
    populateSelect('race', data.races);
    populateSelect('language-select', data.languages);
    populateSelect('damageResistances-select', data.resistances);
    populateSelect('magicResistances-select', data.magicResistance);
    populateSelect('skills-select', data.skills);
    populateSelect('senses-select', data.senses);
    populateSelect('spells-select', data.spellcasting);
    populateSelect('abilities-select', data.abilities);
    populateSelect('actions-select', data.actions);
    populateSelect('reactions-select', data.reactions);
    populateSelect('items-select', data.items);
});

// Populate single select
function populateSelect(id, options) {
    const select = document.getElementById(id);
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Select';
    select.appendChild(opt);
    options.forEach(option => {
        const opt = document.createElement('option');
        opt.value = option.name;
        opt.textContent = option.name;
        select.appendChild(opt);
    });
}

// Add field to container
function addField(fieldType) {
    const select = document.getElementById(`${fieldType}-select`);
    const container = document.getElementById(`${fieldType}-container`);
    const value = select.value;
    const option = data[fieldType].find(item => item.name === value);
    
    if (option) {
        const div = document.createElement('div');
        div.classList.add('field');
        if (fieldType === 'skills') {
            const skillValue = document.getElementById('skills-value').value;
            div.innerHTML = `${option.name}: ${option.description} (Value: ${skillValue}) <button type="button" onclick="removeField(this)">Remove</button>`;
        } else {
            div.innerHTML = `${option.name}: ${option.description} <button type="button" onclick="removeField(this)">Remove</button>`;
        }
        container.appendChild(div);
        updateCharacterSheet();
    }
}

// Remove field from container
function removeField(button) {
    const field = button.parentElement;
    field.remove();
    updateCharacterSheet();
}

// Event listeners
characterForm.addEventListener('submit', saveCharacter);
rollBtns.forEach(btn => btn.addEventListener('click', rollStats));
savePngButton.addEventListener('click', saveAsPng);
characterForm.addEventListener('input', updateCharacterSheet);

// Roll stats function
function rollStats(event) {
    const diceType = event.target.getAttribute('data-dice');
    const [num, sides] = diceType.split('d').map(Number);
    const stats = ['str', 'dex', 'con', 'int', 'cha', 'sta', 'per'];
    stats.forEach(stat => {
        let total = 0;
        for (let i = 0; i < num; i++) {
            total += Math.floor(Math.random() * sides) + 1;
        }
        document.getElementById(stat).value = total;
    });
    updateCharacterSheet();
}

// Update character sheet in real-time
function updateCharacterSheet() {
    const characterData = new FormData(characterForm);
    let displayHtml = '';
    const fields = document.querySelectorAll('.field');
    fields.forEach(field => {
        displayHtml += `<p>${field.innerHTML}</p>`;
    });
    characterData.forEach((value, key) => {
        if (key !== 'portrait' && key !== 'skills-value') {
            displayHtml += `<p><strong>${key}:</strong> ${value}</p>`;
        }
    });
    characterDisplay.innerHTML = displayHtml;
}

// Generate a unique 6-digit ID
function generateUniqueId() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Save character to Firebase
function saveCharacter(event) {
    event.preventDefault();
    const characterData = new FormData(characterForm);
    const characterId = generateUniqueId();
    const characterObj = { id: characterId };
    characterData.forEach((value, key) => {
        if (key !== 'portrait') {
            characterObj[key] = value;
        }
    });
    const portrait = characterData.get('portrait');
    if (portrait) {
        const storageRef = storage.ref().child(`portraits/${characterId}`);
        storageRef.put(portrait).then(snapshot => {
            snapshot.ref.getDownloadURL().then(url => {
                characterObj.portrait = url;
                database.ref('characters/' + characterId).set(characterObj);
                alert('Character saved successfully!');
                characterIdDisplay.innerHTML = `<p>Character ID: ${characterId}</p>`;
            });
        });
    } else {
        database.ref('characters/' + characterId).set(characterObj);
        alert('Character saved successfully!');
        characterIdDisplay.innerHTML = `<p>Character ID: ${characterId}</p>`;
    }
}

// Load character from Firebase
function loadCharacter() {
    const characterId = document.getElementById('character-id').value;
    database.ref('characters/' + characterId).once('value').then(snapshot => {
        const characterData = snapshot.val();
        if (characterData) {
            for (const key in characterData) {
                if (key !== 'portrait' && key !== 'id') {
                    const element = document.getElementById(key);
                    if (element) {
                        element.value = characterData[key];
                    }
                }
            }
            if (characterData.portrait) {
                characterPortrait.src = characterData.portrait;
                characterPortrait.alt = 'Character Portrait';
            }
            characterIdDisplay.innerHTML = `<p>Character ID: ${characterId}</p>`;
            updateCharacterSheet();
        } else {
            alert('Character not found!');
        }
    });
}

// Save character sheet as PNG
function saveAsPng() {
    html2canvas(characterDisplay).then(canvas => {
        const link = document.createElement('a');
        link.download = 'character-sheet.png';
        link.href = canvas.toDataURL();
        link.click();
    });
}

// Apply race modifiers to stats
document.getElementById('race').addEventListener('change', () => {
    const race = document.getElementById('race').value;
    const raceData = data.races.find(r => r.name === race);
    
    if (raceData) {
        const modifiers = raceData.modifiers;
        for (const stat in modifiers) {
            const statInput = document.getElementById(stat.toLowerCase());
            if (statInput) {
                statInput.value = parseInt(statInput.value) + modifiers[stat];
            }
        }
    }
    updateCharacterSheet();
});
