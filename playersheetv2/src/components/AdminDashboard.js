// src/components/AdminDashboard.js
import React, { useState, useEffect } from 'react';
import { ref, get, child, update } from 'firebase/database';
import { database } from '../firebase';
import { List, ListItem, ListItemText, Button, Typography, Box, TextField } from '@mui/material';

const AdminDashboard = ({ characters, updateCharacter }) => {
  const [characters, setCharacters] = useState([]);
  const [selectedCharacter, setSelectedCharacter] = useState(null);

  useEffect(() => {
    const fetchCharacters = async () => {
      const dbRef = ref(database, 'characters');
      const snapshot = await get(dbRef);
      if (snapshot.exists()) {
        setCharacters(Object.values(snapshot.val()));
      } else {
        console.log("No data available");
      }
    };

    fetchCharacters();
  }, []);

  const handleEditCharacter = (character) => {
    setSelectedCharacter(character);
  };

  const handleUpdateCharacter = (updatedCharacter) => {
    const dbRef = ref(database, `characters/${updatedCharacter.id}`);
    update(dbRef, updatedCharacter).then(() => {
      updateCharacter(updatedCharacter);
      setSelectedCharacter(null);
    });
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setSelectedCharacter((prevCharacter) => ({
      ...prevCharacter,
      [name]: value,
    }));
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Admin Dashboard</Typography>
      <Box>
        <Typography variant="h6">Characters List</Typography>
        <List>
          {characters.map((character) => (
            <ListItem key={character.id} button onClick={() => handleEditCharacter(character)}>
              <ListItemText primary={character.title} />
            </ListItem>
          ))}
        </List>
      </Box>
      {selectedCharacter && (
        <Box>
          <Typography variant="h6">Edit Character</Typography>
          <Box component="form" noValidate autoComplete="off">
            <TextField
              label="Title"
              name="title"
              value={selectedCharacter.title}
              onChange={handleChange}
              fullWidth
              margin="normal"
            />
            <Button onClick={() => handleUpdateCharacter(selectedCharacter)} variant="contained" color="primary">
              Update Character
            </Button>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export default AdminDashboard;
