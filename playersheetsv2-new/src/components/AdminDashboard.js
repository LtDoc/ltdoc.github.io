// src/components/AdminDashboard.js

import React, { useState, useEffect } from 'react';
import { database } from '../firebase'; // Import the initialized database
import { ref, get, child, update, push } from 'firebase/database';
import { Box, Typography, TextField, Grid, Button, MenuItem, Select, FormControl, InputLabel } from '@mui/material';
import CharacterCard from './CharacterCard';

const AdminDashboard = () => {
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [characters, setCharacters] = useState([]);
  const [selectedCharacter, setSelectedCharacter] = useState(null);
  const [newCharacter, setNewCharacter] = useState({});
  const [lists, setLists] = useState({
    skills: [],
    senses: [],
    languages: [],
    damageResistance: [],
    magicResistance: [],
    spellcasting: [],
    abilities: [],
    actions: [],
    reactions: []
  });

  useEffect(() => {
    const fetchUsers = async () => {
      const dbRef = ref(database);
      const snapshot = await get(child(dbRef, 'users'));
      if (snapshot.exists()) {
        setUsers(Object.entries(snapshot.val()).map(([id, user]) => ({ id, ...user })));
      }
    };

    const fetchLists = async () => {
      const dbRef = ref(database);
      const listNames = ['skills', 'senses', 'languages', 'damageResistance', 'magicResistance', 'spellcasting', 'abilities', 'actions', 'reactions'];
      const promises = listNames.map(listName => get(child(dbRef, listName)));
      const results = await Promise.all(promises);

      const fetchedLists = listNames.reduce((acc, listName, index) => {
        acc[listName] = results[index].val() || [];
        return acc;
      }, {});

      setLists(fetchedLists);
    };

    fetchUsers();
    fetchLists();
  }, []);

  const handleUserChange = (e) => {
    const userId = e.target.value;
    setSelectedUser(userId);
    if (userId) {
      const user = users.find(user => user.id === userId);
      setCharacters(user.characters || {});
    } else {
      setCharacters([]);
    }
  };

  const handleCharacterChange = (e) => {
    const characterId = e.target.value;
    setSelectedCharacter(characters[characterId]);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setSelectedCharacter(prevState => ({ ...prevState, [name]: value }));
  };

  const handleStatChange = (e) => {
    const { name, value } = e.target;
    setSelectedCharacter(prevState => ({ ...prevState, stats: { ...prevState.stats, [name]: value } }));
  };

  const handleSubmit = async () => {
    const dbRef = ref(database);
    const updates = {};
    updates[`/users/${selectedUser}/characters/${selectedCharacter.id}`] = selectedCharacter;
    await update(dbRef, updates);
  };

  const handleNewCharacterChange = (e) => {
    const { name, value } = e.target;
    setNewCharacter(prevState => ({ ...prevState, [name]: value }));
  };

  const addNewCharacter = async () => {
    const dbRef = ref(database);
    const newCharacterRef = push(child(dbRef, `users/${selectedUser}/characters`));
    await update(newCharacterRef, newCharacter);
    setCharacters(prevCharacters => ({ ...prevCharacters, [newCharacterRef.key]: newCharacter }));
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Admin Dashboard</Typography>
      <FormControl fullWidth sx={{ mb: 2 }}>
        <InputLabel id="user-select-label">Select User</InputLabel>
        <Select labelId="user-select-label" value={selectedUser} onChange={handleUserChange}>
          <MenuItem value=""><em>None</em></MenuItem>
          {users.map(user => (
            <MenuItem key={user.id} value={user.id}>{user.username}</MenuItem>
          ))}
        </Select>
      </FormControl>
      {selectedUser && (
        <Box>
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel id="character-select-label">Select Character</InputLabel>
            <Select labelId="character-select-label" value={selectedCharacter?.id || ''} onChange={handleCharacterChange}>
              <MenuItem value=""><em>None</em></MenuItem>
              {Object.entries(characters).map(([id, character]) => (
                <MenuItem key={id} value={id}>{character.name}</MenuItem>
              ))}
            </Select>
          </FormControl>
          {selectedCharacter && (
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <Box>
                  <TextField
                    label="Name"
                    name="name"
                    value={selectedCharacter.name}
                    onChange={handleChange}
                    fullWidth
                    sx={{ mb: 2 }}
                  />
                  <TextField
                    label="Class"
                    name="class"
                    value={selectedCharacter.class}
                    onChange={handleChange}
                    fullWidth
                    sx={{ mb: 2 }}
                  />
                  <TextField
                    label="Race"
                    name="race"
                    value={selectedCharacter.race}
                    onChange={handleChange}
                    fullWidth
                    sx={{ mb: 2 }}
                  />
                  <TextField
                    label="Challenge"
                    name="challenge"
                    value={selectedCharacter.challenge}
                    onChange={handleChange}
                    fullWidth
                    sx={{ mb: 2 }}
                  />
                  <TextField
                    label="HP"
                    name="hp"
                    value={selectedCharacter.hp}
                    onChange={handleChange}
                    fullWidth
                    sx={{ mb: 2 }}
                  />
                  <TextField
                    label="AC"
                    name="ac"
                    value={selectedCharacter.ac}
                    onChange={handleChange}
                    fullWidth
                    sx={{ mb: 2 }}
                  />
                  <Typography variant="h6" gutterBottom>Stats</Typography>
                  {['str', 'dex', 'int', 'cha', 'sta', 'con', 'per'].map(stat => (
                    <TextField
                      key={stat}
                      label={stat.toUpperCase()}
                      name={stat}
                      value={selectedCharacter.stats?.[stat] || ''}
                      onChange={handleStatChange}
                      fullWidth
                      sx={{ mb: 2 }}
                    />
                  ))}
                  <Button variant="contained" color="primary" onClick={handleSubmit}>
                    Update Character
                  </Button>
                </Box>
              </Grid>
              <Grid item xs={6}>
                <CharacterCard character={selectedCharacter} />
              </Grid>
            </Grid>
          )}
          <Box mt={4}>
            <Typography variant="h5" gutterBottom>Add New Character</Typography>
            <TextField
              label="Name"
              name="name"
              value={newCharacter.name || ''}
              onChange={handleNewCharacterChange}
              fullWidth
              sx={{ mb: 2 }}
            />
            <TextField
              label="Class"
              name="class"
              value={newCharacter.class || ''}
              onChange={handleNewCharacterChange}
              fullWidth
              sx={{ mb: 2 }}
            />
            <TextField
              label="Race"
              name="race"
              value={newCharacter.race || ''}
              onChange={handleNewCharacterChange}
              fullWidth
              sx={{ mb: 2 }}
            />
            <TextField
              label="Challenge"
              name="challenge"
              value={newCharacter.challenge || ''}
              onChange={handleNewCharacterChange}
              fullWidth
              sx={{ mb: 2 }}
            />
            <TextField
              label="HP"
              name="hp"
              value={newCharacter.hp || ''}
              onChange={handleNewCharacterChange}
              fullWidth
              sx={{ mb: 2 }}
            />
            <TextField
              label="AC"
              name="ac"
              value={newCharacter.ac || ''}
              onChange={handleNewCharacterChange}
              fullWidth
              sx={{ mb: 2 }}
            />
            <Typography variant="h6" gutterBottom>Stats</Typography>
            {['str', 'dex', 'int', 'cha', 'sta', 'con', 'per'].map(stat => (
              <TextField
                key={stat}
                label={stat.toUpperCase()}
                name={stat}
                value={newCharacter.stats?.[stat] || ''}
                onChange={handleNewCharacterChange}
                fullWidth
                sx={{ mb: 2 }}
              />
            ))}
            <Button variant="contained" color="primary" onClick={addNewCharacter}>
              Add Character
            </Button>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export default AdminDashboard;
