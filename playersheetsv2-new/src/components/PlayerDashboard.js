// src/components/PlayerDashboard.js

import React, { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { getDatabase, ref, child, get, update, push } from 'firebase/database';
import { Box, Typography, TextField, Grid, Button, MenuItem, Select, FormControl, InputLabel } from '@mui/material';
import CharacterCard from './CharacterCard';

const PlayerDashboard = () => {
  const location = useLocation();
  const userId = location.state?.userId || '';
  const [user, setUser] = useState(null);
  const [selectedCharacter, setSelectedCharacter] = useState(null);
  const [characters, setCharacters] = useState([]);
  const [newCharacter, setNewCharacter] = useState({
    stats: {}
  });

  useEffect(() => {
    if (userId) {
      const fetchUser = async () => {
        const dbRef = ref(getDatabase());
        const snapshot = await get(child(dbRef, `users/${userId}`));
        if (snapshot.exists()) {
          const userData = snapshot.val();
          setUser(userData);
          setCharacters(userData.characters || {});
        }
      };
      fetchUser();
    }
  }, [userId]);

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
    if (selectedCharacter) {
      const dbRef = ref(getDatabase());
      const updates = {};
      updates[`/users/${userId}/characters/${selectedCharacter.id}`] = selectedCharacter;
      await update(dbRef, updates);
    }
  };

  const handleNewCharacterChange = (e) => {
    const { name, value } = e.target;
    setNewCharacter(prevState => ({ ...prevState, [name]: value }));
  };

  const addNewCharacter = async () => {
    const dbRef = ref(getDatabase());
    const newCharacterRef = push(child(dbRef, `users/${userId}/characters`));
    await update(newCharacterRef, newCharacter);
    setCharacters(prevCharacters => ({ ...prevCharacters, [newCharacterRef.key]: newCharacter }));
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Player Dashboard</Typography>
      {user && (
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
                  {Object.entries(selectedCharacter.stats).map(([key, value]) => (
                    <TextField
                      key={key}
                      label={key.toUpperCase()}
                      name={key}
                      value={value}
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
              value={newCharacter.name}
              onChange={handleNewCharacterChange}
              fullWidth
              sx={{ mb: 2 }}
            />
            <TextField
              label="Class"
              name="class"
              value={newCharacter.class}
              onChange={handleNewCharacterChange}
              fullWidth
              sx={{ mb: 2 }}
            />
            <TextField
              label="Race"
              name="race"
              value={newCharacter.race}
              onChange={handleNewCharacterChange}
              fullWidth
              sx={{ mb: 2 }}
            />
            <TextField
              label="Challenge"
              name="challenge"
              value={newCharacter.challenge}
              onChange={handleNewCharacterChange}
              fullWidth
              sx={{ mb: 2 }}
            />
            <TextField
              label="HP"
              name="hp"
              value={newCharacter.hp}
              onChange={handleNewCharacterChange}
              fullWidth
              sx={{ mb: 2 }}
            />
            <TextField
              label="AC"
              name="ac"
              value={newCharacter.ac}
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
                value={newCharacter.stats[stat] || ''}
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

export default PlayerDashboard;
