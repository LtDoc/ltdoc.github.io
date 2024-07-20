// src/Login.js

import React, { useState } from 'react';
import { Box, Typography, TextField, Button } from '@mui/material';
import { useNavigate } from 'react-router-dom';

const Login = ({ setIsAuthenticated, setIsAdmin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();

  const handleLogin = () => {
    if (username === 'admin' && password === 'password') {
      setIsAuthenticated(true);
      setIsAdmin(true);
      navigate('/admin');
    } else {
      // Placeholder for actual user authentication logic
      setIsAuthenticated(true);
      navigate('/player');
    }
  };

  return (
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
      <Button variant="contained" color="primary" onClick={handleLogin}>
        Login
      </Button>
      <Button variant="contained" color="secondary" onClick={() => navigate('/register')}>
        Create New User
      </Button>
    </Box>
  );
};

export default Login;
