// Initialize Firebase
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_AUTH_DOMAIN",
    databaseURL: "YOUR_DATABASE_URL",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_STORAGE_BUCKET",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
  };
  
  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }
  
  const auth = firebase.auth();
  const db = firebase.database();
  const itemsPerPage = 5;
  let currentPage = 0;
  let currentCategory = '';
  
  document.getElementById('sign-in').addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    try {
      const userRef = db.ref(`users_new/${username}`);
      const snapshot = await userRef.once('value');
      const user = snapshot.val();
      if (user && user.password === password) {
        onSignIn({ username, characterName: user.characterName });
      } else {
        alert("Invalid username or password");
      }
    } catch (error) {
      console.error("Error signing in:", error);
    }
  });
  
  function onSignIn(user) {
    document.getElementById('home').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    fetchCard(user.username);
  }
  
  async function fetchCard(username) {
    try {
      const cardRef = db.ref(`cards/${username}`);
      const snapshot = await cardRef.once('value');
      const cardData = snapshot.val();
      if (cardData) {
        displayCard(cardData);
      }
    } catch (error) {
      console.error("Error fetching card:", error);
    }
  }
  
  function displayCard(cardData) {
    const card = document.getElementById('card');
    card.innerHTML = `
      <div class="mon-stat-block">
        <div class="mon-stat-block__header">
          <div class="mon-stat-block__name">${cardData.characterName}</div>
          <div class="mon-stat-block__meta">${cardData.race}, ${cardData.alignment}</div>
        </div>
        <div class="mon-stat-block__separator"></div>
        <div class="mon-stat-block__attributes">
          <div class="mon-stat-block__attribute">
            <span class="mon-stat-block__attribute-label">Armor Class</span>
            <span class="mon-stat-block__attribute-value">${cardData.AC}</span>
          </div>
          <div class="mon-stat-block__attribute">
            <span class="mon-stat-block__attribute-label">Level</span>
            <span class="mon-stat-block__attribute-value">${cardData.level}</span>
          </div>
          <div class="mon-stat-block__attribute">
            <span class="mon-stat-block__attribute-label">Speed</span>
            <span class="mon-stat-block__attribute-value">${cardData.speed}</span>
          </div>
        </div>
        <div class="mon-stat-block__separator"></div>
        <div class="ability-block">
          <div class="ability-block__stat ability-block__stat--str">
            <div class="ability-block__heading">STR</div>
            <div class="ability-block__data">
              <span class="ability-block__score">${cardData.STR}</span>
              <span class="ability-block__modifier">(${calculateModifier(cardData.STR)})</span>
            </div>
          </div>
          <div class="ability-block__stat ability-block__stat--dex">
            <div class="ability-block__heading">DEX</div>
            <div class="ability-block__data">
              <span class="ability-block__score">${cardData.DEX}</span>
              <span class="ability-block__modifier">(${calculateModifier(cardData.DEX)})</span>
            </div>
          </div>
          <div class="ability-block__stat ability-block__stat--con">
            <div class="ability-block__heading">CON</div>
            <div class="ability-block__data">
              <span class="ability-block__score">${cardData.CON}</span>
              <span class="ability-block__modifier">(${calculateModifier(cardData.CON)})</span>
            </div>
          </div>
          <div class="ability-block__stat ability-block__stat--int">
            <div class="ability-block__heading">INT</div>
            <div class="ability-block__data">
              <span class="ability-block__score">${cardData.INT}</span>
              <span class="ability-block__modifier">(${calculateModifier(cardData.INT)})</span>
            </div>
          </div>
          <div class="ability-block__stat ability-block__stat--wis">
            <div class="ability-block__heading">WIS</div>
            <div class="ability-block__data">
              <span class="ability-block__score">${cardData.WIS}</span>
              <span class="ability-block__modifier">(${calculateModifier(cardData.WIS)})</span>
            </div>
          </div>
          <div class="ability-block__stat ability-block__stat--cha">
            <div class="ability-block__heading">CHA</div>
            <div class="ability-block__data">
              <span class="ability-block__score">${cardData.CHA}</span>
              <span class="ability-block__modifier">(${calculateModifier(cardData.CHA)})</span>
            </div>
          </div>
        </div>
        <div class="mon-stat-block__separator"></div>
        <div class="mon-stat-block__tidbits">
          <div class="mon-stat-block__tidbit">
            <span class="mon-stat-block__tidbit-label">Skills</span>
            <span class="mon-stat-block__tidbit-data">${formatList(cardData.skills)}</span>
          </div>
          <div class="mon-stat-block__tidbit">
            <span class="mon-stat-block__tidbit-label">Senses</span>
            <span class="mon-stat-block__tidbit-data">${cardData.senses}</span>
          </div>
          <div class="mon-stat-block__tidbit">
            <span class="mon-stat-block__tidbit-label">Languages</span>
            <span class="mon-stat-block__tidbit-data">${cardData.languages}</span>
          </div>
          <div class="mon-stat-block__tidbit-container">
            <div class="mon-stat-block__tidbit">
              <span class="mon-stat-block__tidbit-label">Challenge</span>
              <span class="mon-stat-block__tidbit-data">${cardData.challenge}</span>
            </div>
            <div class="mon-stat-block__tidbit-spacer"></div>
            <div class="mon-stat-block__tidbit">
              <span class="mon-stat-block__tidbit-label">Proficiency Bonus</span>
              <span class="mon-stat-block__tidbit-data">${cardData.proficiencyBonus}</span>
            </div>
          </div>
        </div>
        <div class="mon-stat-block__separator"></div>
        <div class="mon-stat-block__description-blocks">
          ${formatDescriptionBlock(cardData.abilities, "Abilities")}
          ${formatDescriptionBlock(cardData.spells, "Spellcasting")}
          ${formatDescriptionBlock(cardData.actions, "Actions")}
        </div>
      </div>
    `;
  }
  
  function calculateModifier(score) {
    const modifier = Math.floor((score - 10) / 2);
    return modifier >= 0 ? `+${modifier}` : modifier;
  }
  
  function formatList(items) {
    if (!items) return '';
    return items.map(item => `<strong>${item.name}:</strong> ${item.description}`).join(', ');
  }
  
  function formatDescriptionBlock(items, heading) {
    if (!items || items.length === 0) return '';
    return `
      <div class="mon-stat-block__description-block">
        <div class="mon-stat-block__description-block-heading">${heading}</div>
        <div class="mon-stat-block__description-block-content">
          ${items.map(item => `<p><em><strong>${item.name}.</strong></em> ${item.description}</p>`).join('')}
        </div>
      </div>
    `;
  }
  
  document.getElementById('update-card').addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const newCardData = {
      AC: document.getElementById('ac').value,
      level: document.getElementById('level').value,
      race: document.getElementById('race').value,
      alignment: document.getElementById('alignment').value,
      speed: document.getElementById('speed').value,
      abilities: [],
      spells: [],
      actions: [],
      senses: document.getElementById('senses').value,
      languages: document.getElementById('languages').value,
      challenge: document.getElementById('challenge').value,
      proficiencyBonus: document.getElementById('proficiencyBonus').value,
      skills: [],
      STR: document.getElementById('str').value,
      DEX: document.getElementById('dex').value,
      CON: document.getElementById('con').value,
      INT: document.getElementById('int').value,
      WIS: document.getElementById('wis').value,
      CHA: document.getElementById('cha').value,
    };
  
    try {
      const cardRef = db.ref(`cards/${username}`);
      await cardRef.update(newCardData);
      fetchCard(username);
    } catch (error) {
      console.error("Error updating card:", error);
    }
  });
  
  // Admin Functions
  document.getElementById('level-up').addEventListener('click', async () => {
    const levelUpPoints = Number(document.getElementById('level-up-points').value);
    const username = prompt("Enter the username to level up:");
  
    if (!username) return;
  
    try {
      const cardRef = db.ref(`cards/${username}`);
      const snapshot = await cardRef.once('value');
      const card = snapshot.val();
  
      if (card) {
        const updatedCard = {
          ...card,
          CHA: Number(card.CHA) + levelUpPoints,
          // Add logic for other stats if needed
        };
        await cardRef.update(updatedCard);
        alert(`Leveled up ${username}!`);
      }
    } catch (error) {
      console.error("Error leveling up card:", error);
    }
  });
  
  async function fetchAllCards() {
    try {
      const cardsRef = db.ref('cards');
      const snapshot = await cardsRef.once('value');
      const cards = snapshot.val();
      displayAllCards(cards);
    } catch (error) {
      console.error("Error fetching all cards:", error);
    }
  }
  
  function displayAllCards(cards) {
    const playerCards = document.getElementById('player-cards');
    playerCards.innerHTML = '';
    Object.keys(cards).forEach((username) => {
      const li = document.createElement('li');
      li.textContent = `${username}: ${cards[username].characterName}`;
      playerCards.appendChild(li);
    });
  }
  
  // Add options to the database
  document.getElementById('add-option-button').addEventListener('click', async () => {
    const category = document.getElementById('option-category').value;
    const name = document.getElementById('option-name').value;
    const description = document.getElementById('option-description').value;
  
    if (!category || !name || !description) {
      alert("All fields are required!");
      return;
    }
  
    try {
      const optionsRef = db.ref(`options/${category}`);
      const newOptionRef = optionsRef.push();
      await newOptionRef.set({ name, description });
      alert(`Option added to ${category}`);
    } catch (error) {
      console.error("Error adding option:", error);
    }
  });
  
  // Fetch options from the database
  async function fetchOptions(category, searchQuery = '') {
    try {
      const optionsRef = db.ref(`options/${category}`);
      const snapshot = await optionsRef.once('value');
      const options = snapshot.val();
      if (options) {
        displayOptions(options, searchQuery);
      }
    } catch (error) {
      console.error("Error fetching options:", error);
    }
  }
  
  function displayOptions(options, searchQuery) {
    const optionsList = document.getElementById('options-list');
    optionsList.innerHTML = '';
    const filteredOptions = Object.values(options).filter(option =>
      option.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
    const paginatedOptions = filteredOptions.slice(currentPage * itemsPerPage, (currentPage + 1) * itemsPerPage);
    paginatedOptions.forEach(option => {
      const optionItem = document.createElement('div');
      optionItem.textContent = `${option.name}: ${option.description}`;
      optionsList.appendChild(optionItem);
    });
    document.getElementById('pagination').style.display = 'block';
  }
  
  document.getElementById('prev-page').addEventListener('click', () => {
    if (currentPage > 0) {
      currentPage--;
      fetchOptions(currentCategory, document.getElementById('search').value);
    }
  });
  
  document.getElementById('next-page').addEventListener('click', () => {
    currentPage++;
    fetchOptions(currentCategory, document.getElementById('search').value);
  });
  
  document.getElementById('search').addEventListener('input', () => {
    fetchOptions(currentCategory, document.getElementById('search').value);
  });
  
  document.getElementById('edit-abilities').addEventListener('click', () => {
    currentCategory = 'abilities';
    currentPage = 0;
    fetchOptions(currentCategory);
  });
  
  document.getElementById('edit-spells').addEventListener('click', () => {
    currentCategory = 'spells';
    currentPage = 0;
    fetchOptions(currentCategory);
  });
  
  document.getElementById('edit-languages').addEventListener('click', () => {
    currentCategory = 'languages';
    currentPage = 0;
    fetchOptions(currentCategory);
  });
  
  // Call this function to fetch and display all cards for admin
  fetchAllCards();
  