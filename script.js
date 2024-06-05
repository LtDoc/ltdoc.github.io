document.addEventListener('DOMContentLoaded', function() {
    console.log('Data loaded:', data);
    populateForm(data);
});

function populateForm(data) {
    populateSelect('skills', data.skills);
    populateSelect('senses', data.senses);
    populateSelect('languages', data.languages);
    populateSelect('resistances', data.resistances);
    populateSelect('magicResistance', data.magicResistance);
    populateSelect('spellcasting', data.spellcasting);
    populateSelect('abilities', data.abilities);
    populateSelect('actions', data.actions);
    populateSelect('reactions', data.reactions);
    populateSelect('items', data.items);
    populateSelect('class', data.classes);
    populateSelect('race', data.races);

    document.getElementById('race').addEventListener('change', updateModifiers);
}

function populateSelect(id, options) {
    const select = document.getElementById(id);
    if (!select) {
        console.error(`Element with id ${id} not found.`);
        return;
    }
    options.forEach(option => {
        const opt = document.createElement('option');
        opt.value = option.name;
        opt.innerHTML = option.name;
        select.appendChild(opt);
    });
}

function updateModifiers() {
    const race = document.getElementById('race').value;
    const raceData = data.races.find(r => r.name === race);
    if (raceData) {
        for (const stat in raceData.modifiers) {
            const modDisplay = document.getElementById(`mod${stat}`);
            if (modDisplay) {
                modDisplay.innerText = raceData.modifiers[stat];
            }
        }
    }
}

window.addSkill = function addSkill() {
    const select = document.getElementById('skills');
    const value = document.getElementById('skillsValue').value;
    const list = document.getElementById('skillsList');
    const selectedOption = select.options[select.selectedIndex].value;

    const li = document.createElement('li');
    li.innerHTML = `${selectedOption}: ${value} <button style="color: red; margin-left: 10px;" onclick="this.parentElement.remove()">X</button>`;
    list.appendChild(li);
    document.getElementById('skillsValue').value = ''; // Clear the value input after adding
}

window.addAbility = function addAbility(selectId, listId) {
    const select = document.getElementById(selectId);
    const list = document.getElementById(listId);
    const selectedOption = select.options[select.selectedIndex].value;

    const li = document.createElement('li');
    li.innerHTML = `${selectedOption} <button style="color: red; margin-left: 10px;" onclick="this.parentElement.remove()">X</button>`;
    list.appendChild(li);
}

window.buildCard = function buildCard() {
    const cardTitle = document.getElementById('cardTitle');
    const cardImage = document.getElementById('cardImage');
    const cardChallenge = document.getElementById('cardChallenge');
    const cardHP = document.getElementById('cardHP');
    const cardAC = document.getElementById('cardAC');
    const cardStats = document.getElementById('cardStats');
    const cardSkills = document.getElementById('cardSkills');
    const cardSenses = document.getElementById('cardSenses');
    const cardLanguages = document.getElementById('cardLanguages');
    const cardResistances = document.getElementById('cardResistances');
    const cardMagicResistance = document.getElementById('cardMagicResistance');
    const cardSpellcasting = document.getElementById('cardSpellcasting');
    const cardAbilities = document.getElementById('cardAbilities');
    const cardActions = document.getElementById('cardActions');
    const cardReactions = document.getElementById('cardReactions');
    const cardItems = document.getElementById('cardItems');
    const cardClass = document.getElementById('classDisplay');

    if (!cardTitle || !cardImage || !cardChallenge || !cardHP || !cardAC || !cardStats || !cardSkills || !cardSenses || !cardLanguages || !cardResistances || !cardMagicResistance || !cardSpellcasting || !cardAbilities || !cardActions || !cardReactions || !cardItems || !cardClass) {
        console.error('One or more elements not found in the DOM.');
        return;
    }

    cardTitle.innerText = document.getElementById('title').value;
    cardChallenge.innerText = "Level: " + document.getElementById('challenge').value;
    cardHP.innerHTML = `<span class="icon-heart">❤</span> ${document.getElementById('hp').value}`;
    cardAC.innerHTML = `<span class="icon-shield">🛡</span> ${document.getElementById('ac').value}`;

    // Collecting the stats from individual input boxes
    const stats = {
        STR: document.getElementById('stat1').value,
        DEX: document.getElementById('stat2').value,
        INT: document.getElementById('stat3').value,
        CHA: document.getElementById('stat4').value,
        STA: document.getElementById('stat5').value,
        CON: document.getElementById('stat6').value,
        PER: document.getElementById('stat7').value,
    };

    const race = document.getElementById('race').value;
    const raceData = data.races.find(r => r.name === race);
    const modifiers = raceData ? raceData.modifiers : {};

    cardStats.innerHTML = formatStats(stats, modifiers);

    cardClass.innerText = `Class: ${document.getElementById('class').value}`;

    cardSkills.innerHTML = `<strong>Skills:</strong> ${formatAbilities('skillsList', data.skills)}`;
    cardSenses.innerHTML = `<strong>Senses:</strong> ${formatAbilities('sensesList', data.senses)}`;
    cardLanguages.innerHTML = `<strong>Languages:</strong> ${formatAbilities('languagesList', data.languages)}`;
    cardResistances.innerHTML = `<strong>Damage Resistances:</strong> ${formatAbilities('resistancesList', data.resistances)}`;
    cardMagicResistance.innerHTML = `<strong>Magic Resistance:</strong> ${formatAbilities('magicResistanceList', data.magicResistance)}`;
    cardSpellcasting.innerHTML = `<strong>Spellcasting:</strong> ${formatAbilities('spellcastingList', data.spellcasting)}`;
    cardAbilities.innerHTML = `<strong>Abilities:</strong> ${formatAbilities('abilitiesList', data.abilities)}`;
    cardActions.innerHTML = `<strong>Actions:</strong> ${formatAbilities('actionsList', data.actions)}`;
    cardReactions.innerHTML = `<strong>Reactions:</strong> ${formatAbilities('reactionsList', data.reactions)}`;
    cardItems.innerHTML = `<strong>Equipment:</strong> ${formatItems('itemsList', data.items)}`;

    // Set the image
    const imageUrl = document.getElementById('image').value;
    cardImage.src = imageUrl ? imageUrl : '';
    cardImage.style.display = imageUrl ? 'block' : 'none';

    toggleSection('toggleSkills', 'cardSkills');
    toggleSection('toggleSenses', 'cardSenses');
    toggleSection('toggleLanguages', 'cardLanguages');
    toggleSection('toggleResistances', 'cardResistances');
    toggleSection('toggleMagicResistance', 'cardMagicResistance');
    toggleSection('toggleSpellcasting', 'cardSpellcasting');
    toggleSection('toggleAbilities', 'cardAbilities');
    toggleSection('toggleActions', 'cardActions');
    toggleSection('toggleReactions', 'cardReactions');
    toggleSection('toggleItems', 'cardItems');

    // Generate the seed
    generateSeed();
};

function generateSeed() {
    const formElements = document.getElementById('cardForm').elements;
    const formData = {};

    for (let element of formElements) {
        if (element.id) {
            if (element.type === 'checkbox') {
                formData[element.id] = element.checked;
            } else if (element.tagName === 'UL') {
                formData[element.id] = Array.from(element.children).map(li => li.innerText.split(' ')[0]); // Ignore the remove button
            } else {
                formData[element.id] = element.value;
            }
        }
    }

    const seed = btoa(encodeURIComponent(JSON.stringify(formData)));
    document.getElementById('generatedSeed').value = seed;
}

window.loadSeed = function loadSeed() {
    const seed = document.getElementById('seedInput').value;

    if (!seed) {
        alert('Please enter a seed.');
        return;
    }

    try {
        const formData = JSON.parse(decodeURIComponent(atob(seed)));
        for (let key in formData) {
            const element = document.getElementById(key);
            if (element) {
                if (element.type === 'checkbox') {
                    element.checked = formData[key];
                } else if (element.tagName === 'UL') {
                    element.innerHTML = '';
                    formData[key].forEach(item => {
                        const li = document.createElement('li');
                        li.innerHTML = `${item} <button style="color: red; margin-left: 10px;" onclick="this.parentElement.remove()">X</button>`;
                        element.appendChild(li);
                    });
                } else {
                    element.value = formData[key];
                }
            }
        }
        buildCard(); // Build the card with the loaded data
    } catch (error) {
        alert('Invalid seed. Please try again.');
        console.error('Error loading seed:', error);
    }
};

function formatAbilities(listId, dataList) {
    const listItems = Array.from(document.getElementById(listId).children);
    const abilities = listItems.map(li => {
        const itemText = li.innerText.replace(' X', '').trim(); // Remove the "X" and any extra spaces
        const itemName = itemText.split(':')[0].trim(); // Get the name of the skill from the list item
        const itemValue = itemText.split(':')[1] ? itemText.split(':')[1].trim() : ''; // Get the user-provided value, if any
        const itemData = dataList.find(item => item.name === itemName);
        if (itemData) {
            if (listId === 'skillsList') { // Check if it's the skills list to append the level
                return `${itemData.name}: ${itemData.description} (Level: ${itemValue})`; // Append level only for skills
            } else {
                return `${itemData.name}: ${itemData.description}`; // For other abilities, do not append level
            }
        }
        return `${itemName}: ${itemValue}`; // Fallback if no matching item in data.js, without labeling it explicitly as "Level"
    }).join('<br>');
    return abilities;
}

function formatStats(stats, modifiers) {
    return Object.entries(stats).map(([key, value]) => `<strong>${key}</strong>: ${value} (${modifiers[key]})`).join(' | ');
}

function formatItems(listId, dataList) {
    const listItems = Array.from(document.getElementById(listId).children);
    const items = listItems.map(li => {
        const itemText = li.innerText.replace(' X', '').trim(); // Remove the "X" and any extra spaces
        const itemName = itemText.split(':')[0].trim(); // Get the name of the item
        const itemValue = itemText.split(':')[1] ? itemText.split(':')[1].trim() : ''; // Get the user-provided value, if any
        const itemData = dataList.find(item => item.name === itemName);
        if (itemData) {
            return `${itemData.name}: ${itemData.description} ${itemValue ? `(Level: ${itemValue})` : ''}`; // Append level only for items
        }
        return `${itemName}: ${itemValue}`; // Fallback if no matching item in data.js, without labeling it explicitly as "Level"
    }).join('<br>');
    return items;
}

function toggleSection(toggleId, sectionId) {
    const toggle = document.getElementById(toggleId);
    const section = document.getElementById(sectionId);
    section.style.display = toggle.checked ? 'block' : 'none';
}

window.rollStats = function rollStats(dice) {
    const stats = ['stat1', 'stat2', 'stat3', 'stat4', 'stat5', 'stat6', 'stat7'];
    stats.forEach(stat => {
        document.getElementById(stat).value = rollDice(dice);
    });
}

function rollDice(dice) {
    return Math.floor(Math.random() * dice) + 1;
}

window.clearForm = function clearForm() {
    document.getElementById('cardForm').reset();
    document.getElementById('skillsList').innerHTML = '';
    document.getElementById('sensesList').innerHTML = '';
    document.getElementById('languagesList').innerHTML = '';
    document.getElementById('resistancesList').innerHTML = '';
    document.getElementById('magicResistanceList').innerHTML = '';
    document.getElementById('spellcastingList').innerHTML = '';
    document.getElementById('abilitiesList').innerHTML = '';
    document.getElementById('actionsList').innerHTML = '';
    document.getElementById('reactionsList').innerHTML = '';
    document.getElementById('itemsList').innerHTML = '';
    document.getElementById('generatedSeed').value = '';
}
