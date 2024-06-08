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
    populateSelect('language', data.languages);
    populateSelect('damageResistances', data.resistances);
    populateSelect('magicResistances', data.magicResistance);

    populateMultiSelect('skills', data.skills);
    populateMultiSelect('senses', data.senses);
    populateMultiSelect('spells', data.spellcasting);
    populateMultiSelect('abilities', data.abilities);
    populateMultiSelect('actions', data.actions);
    populateMultiSelect('reactions', data.reactions);
    populateMultiSelect('items', data.items);
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

// Populate multi-select fields
function populateMultiSelect(id, options) {
    const container = document.getElementById(id);
    options.forEach(option => {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = option.name;
        checkbox.name = id;
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(`${option.name}: ${option.description}`));
        container.appendChild(label);
    });
}

// Event listeners
characterForm.addEventListener('submit', saveCharacter);
rollStatsButton.addEventListener('click', rollStats);
savePngButton.addEventListener('click', saveAsPng);
characterForm.addEventListener('input', updateCharacterSheet);

// Roll stats function
function rollStats() {
    const stats = ['hp', 'ac'];
    stats.forEach(stat => {
        const diceType = prompt(`Enter dice type for ${stat} (e.g., 1d6, 1d8, 1d10, 1d20):`);
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
