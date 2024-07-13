// src/migrateCharacterData.js

import { getDatabase, ref, get, child, update, remove } from 'firebase/database';

const migrateCharacterData = async () => {
  const db = getDatabase();
  const dbRef = ref(db);
  
  try {
    const usersSnapshot = await get(child(dbRef, 'users'));
    const charactersSnapshot = await get(child(dbRef, 'characters'));
    
    if (usersSnapshot.exists() && charactersSnapshot.exists()) {
      const users = usersSnapshot.val();
      const characters = charactersSnapshot.val();

      // Iterate over each character and assign it to the corresponding user
      for (const charId in characters) {
        const character = characters[charId];
        const { username } = character;

        // Find the user with the matching username
        const user = Object.entries(users).find(([userId, user]) => user.username === username);

        if (user) {
          const [userId] = user;

          // Update the user with the new character structure
          await update(ref(db, `users/${userId}/characters/${charId}`), character);
        }
      }

      // Remove the old 'characters' node
      await remove(ref(db, 'characters'));
      console.log('Migration completed successfully.');
    } else {
      console.log('No users or characters data found.');
    }
  } catch (error) {
    console.error('Error migrating data:', error);
  }
};

migrateCharacterData();
