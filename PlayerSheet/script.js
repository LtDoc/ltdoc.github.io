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
const rollStatsButton = document.getElementById('rollStats');

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
        div.innerHTML = `${option.name}: ${option.description} <button type="button" onclick="removeField(this)">Remove</button>`;
        container.appendChild(div);
    }
}

// Remove field from container
function removeField(button) {
    const field = button.parentElement;
    field.remove();
}

// Event listeners
characterForm.addEventListener('submit', saveCharacter);
rollStatsButton.addEventListener('click', rollStats);
savePngButton.addEventListener('click', saveAsPng);
characterForm.addEventListener('input', updateCharacterSheet);

// Roll stats function
function rollStats() {
    const stats = ['str', 'dex', 'con', 'int', 'cha', 'sta', 'per'];
    stats.forEach(stat => {
        const diceType = prompt(`Enter dice type for ${stat.toUpperCase()} (e.g., 1d6, 1d8, 1d10, 1d20):`);
        const [num, sides] = diceType.split('d').map(Number);
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
    characterData.forEach((value, key) => {
        displayHtml += `<p><strong>${key}:</strong> ${value}</p>`;
    });
    characterDisplay.innerHTML = displayHtml;
}

// Save character to Firebase
function saveCharacter(event) {
    event.preventDefault();
    const characterData = new FormData(characterForm);
    const characterId = database.ref().child('characters').push().key;
    const characterObj = {};
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
            });
        });
    } else {
        database.ref('characters/' + characterId).set(characterObj);
        alert('Character saved successfully!');
    }
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
