// src/components/Home.js

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Box, Typography, TextField, Button } from '@mui/material';
import { auth, database } from '../firebase';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { ref, get, child } from 'firebase/database';

const Home = ({ setIsAuthenticated, setIsAdmin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleLogin = async () => {
    try {
      const dbRef = ref(database);
      const snapshot = await get(child(dbRef, 'users'));
      if (snapshot.exists()) {
        const users = snapshot.val();
        const userEntry = Object.entries(users).find(([id, user]) => user.username === username && user.password === password);
        
        if (userEntry) {
          const [userId, user] = userEntry;
          const tempEmail = `${username}@dummyemail.com`;
          await signInWithEmailAndPassword(auth, tempEmail, password);
          setIsAuthenticated(true);
          setIsAdmin(user.isAdmin || false);
          navigate(user.isAdmin ? '/admin' : '/player');
        } else {
          setError('Invalid username or password');
        }
      } else {
        setError('No users found');
      }
    } catch (error) {
      setError(error.message);
    }
  };

  return (
    <Container>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 4 }}>
        <Typography variant="h4" gutterBottom>
          Welcome to The World of Elyndor
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
        {error && <Typography color="error">{error}</Typography>}
        <Button variant="contained" color="primary" onClick={handleLogin}>
          Login
        </Button>
        <Button variant="text" color="secondary" onClick={() => navigate('/register')}>
          Create New User
        </Button>
      </Box>
    </Container>
  );
};

export default Home;
