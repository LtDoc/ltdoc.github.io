// src/components/Login.js

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { database } from '../firebase';
import { ref, get, child } from 'firebase/database';
import { Container, Box, Typography, TextField, Button } from '@mui/material';

const Login = ({ setIsAuthenticated, setIsAdmin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleLogin = async () => {
    try {
      const dbRef = ref(database);
      const snapshot = await get(child(dbRef, `users/${username}`));
      if (!snapshot.exists() || snapshot.val().password !== password) {
        setError("Invalid username or password");
        return;
      }

      setIsAuthenticated(true);
      if (username === 'admin') {
        setIsAdmin(true);
        navigate('/admin');
      } else {
        navigate('/player', { state: { user: snapshot.val() } });
      }
    } catch (error) {
      setError(error.message);
    }
  };

  return (
    <Container>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 4 }}>
        <Typography variant="h4">Login</Typography>
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
      </Box>
    </Container>
  );
};

export default Login;
