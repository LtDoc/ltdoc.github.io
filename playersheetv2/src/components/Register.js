// src/components/Register.js
import React, { useState } from 'react';
import { ref, set } from 'firebase/database';
import { database } from '../firebase';
import bcrypt from 'bcryptjs';
import { TextField, Button, Container, Typography, Box } from '@mui/material';

const Register = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  const handleRegister = async (e) => {
    e.preventDefault();
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const userId = generateUniqueId();
      await set(ref(database, 'users_new/' + userId), {
        username,
        password: hashedPassword
      });
      setUsername('');
      setPassword('');
      setError(null);
    } catch (error) {
      setError(error.message);
    }
  };

  const generateUniqueId = () => {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
  };

  return (
    <Container>
      <Box component="form" onSubmit={handleRegister} sx={{ mt: 5 }}>
        <Typography variant="h4" gutterBottom>Register</Typography>
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
          Register
        </Button>
      </Box>
    </Container>
  );
};

export default Register;
