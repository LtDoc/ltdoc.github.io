// src/components/Home.js
import React from 'react';
import { Link } from 'react-router-dom';
import { Box, Typography, Button, Container } from '@mui/material';

const Home = () => {
  return (
    <Container>
      <Box sx={{ textAlign: 'center', mt: 5 }}>
        <Typography variant="h3" gutterBottom>Welcome to the Character Manager</Typography>
        <Typography variant="h5" gutterBottom>Manage your characters and more</Typography>
        <Box sx={{ mt: 3 }}>
          <Button component={Link} to="/admin" variant="contained" color="primary" sx={{ mr: 2 }}>
            Admin Dashboard
          </Button>
          <Button component={Link} to="/character-form" variant="contained" color="secondary">
            Add New Character
          </Button>
        </Box>
      </Box>
    </Container>
  );
};

export default Home;
