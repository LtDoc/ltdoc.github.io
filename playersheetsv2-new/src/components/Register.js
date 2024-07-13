// src/components/Register.js

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { database } from '../firebase';
import { ref, set, get, child } from 'firebase/database';
import { Container, Box, Typography, TextField, Button } from '@mui/material';

const Register = ({ setIsAuthenticated }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleRegister = async () => {
    try {
      const dbRef = ref(database);
      const snapshot = await get(child(dbRef, `users/${username}`));
      if (snapshot.exists()) {
        setError("Username already exists");
        return;
      }

      const newCharacter = {
        id: 'character1', // or generate a unique ID
        name: 'New Character',
        class: '',
        race: '',
        challenge: 1,
        hp: 10,
        ac: 10,
        stats: {
          str: 10,
          dex: 10,
          int: 10,
          cha: 10,
          sta: 10,
          con: 10,
          per: 10
        },
        skills: [],
        senses: [],
        languages: [],
        damageResistance: [],
        magicResistance: [],
        spellcasting: [],
        abilities: [],
        actions: [],
        reactions: []
      };

      await set(ref(database, `users/${username}`), {
        username,
        password,
        characters: {
          [newCharacter.id]: newCharacter
        }
      });

      setIsAuthenticated(true);
      navigate('/character-form');
    } catch (error) {
      setError(error.message);
    }
  };

  return (
    <Container>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 4 }}>
        <Typography variant="h4">Register</Typography>
        <TextField
          label="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          fullWidth
          sx={{ mb: 2 }}
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          fullWidth
          sx={{ mb: 2 }}
        />
        {error && <Typography color="error">{error}</Typography>}
        <Button variant="contained" color="primary" onClick={handleRegister}>
          Register
        </Button>
      </Box>
    </Container>
  );
};

export default Register;
