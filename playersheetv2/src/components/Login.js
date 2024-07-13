// src/components/Login.js
import React, { useState } from 'react';
import { ref, get, child } from 'firebase/database';
import { database } from '../firebase';
import bcrypt from 'bcryptjs';
import { TextField, Button, Container, Typography, Box } from '@mui/material';
import { useNavigate } from 'react-router-dom';

const Login = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const dbRef = ref(database);
      const snapshot = await get(child(dbRef, 'users_new'));
      if (snapshot.exists()) {
        const users = snapshot.val();
        const user = Object.values(users).find(user => user.username === username);
        if (user && await bcrypt.compare(password, user.password)) {
          // Authentication successful
          localStorage.setItem('authUser', JSON.stringify(user));
          navigate('/admin');
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
      <Box component="form" onSubmit={handleLogin} sx={{ mt: 5 }}>
        <Typography variant="h4" gutterBottom>Login</Typography>
        {error && <Typography color="error">{error}</Typography>}
        <TextField
          label="Username"
          fullWidth
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          margin="normal"
          required
        />
        <TextField
          label="Password"
          type="password"
          fullWidth
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          margin="normal"
          required
        />
        <Button type="submit" variant="contained" color="primary" fullWidth>
          Login
        </Button>
      </Box>
    </Container>
  );
};

export default Login;
