// src/components/Register.js

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth, database } from '../firebase';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { ref, set } from 'firebase/database';
import { Box, TextField, Button, Typography } from '@mui/material';

const Register = ({ setIsAuthenticated }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();

  const handleRegister = async () => {
    try {
      const dummyEmail = `${username}@dummy.com`;
      const userCredential = await createUserWithEmailAndPassword(auth, dummyEmail, password);
      const userId = userCredential.user.uid;

      // Create initial character for the user
      const initialCharacter = {
        id: 'char1',
        name: 'New Character',
        class: 'Warrior',
        race: 'Human',
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
          per: 10,
        },
      };

      // Save user and character to the database
      await set(ref(database, `users/${userId}`), {
        username,
        characters: {
          [initialCharacter.id]: initialCharacter,
        },
      });

      setIsAuthenticated(true);
      navigate('/player', { state: { userId } });
    } catch (error) {
      console.error('Error registering new user:', error);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 4 }}>
      <Typography variant="h4" gutterBottom>
        Register
      </Typography>
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
      <Button variant="contained" color="primary" onClick={handleRegister}>
        Register
      </Button>
    </Box>
  );
};

export default Register;
