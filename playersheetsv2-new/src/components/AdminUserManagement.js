import React, { useState, useEffect } from 'react';
import { getDatabase, ref, get, child, remove } from 'firebase/database';
import { Box, Typography, Button, MenuItem, Select, FormControl, InputLabel } from '@mui/material';

const AdminUserManagement = () => {
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState('');

  useEffect(() => {
    const fetchUsers = async () => {
      const dbRef = ref(getDatabase());
      const snapshot = await get(child(dbRef, 'users'));
      if (snapshot.exists()) {
        setUsers(Object.entries(snapshot.val()).map(([id, user]) => ({ id, ...user })));
      }
    };

    fetchUsers();
  }, []);

  const handleUserChange = (event) => {
    setSelectedUser(event.target.value);
  };

  const handleDeleteUser = async () => {
    const dbRef = ref(getDatabase());
    await remove(child(dbRef, `users/${selectedUser}`));
    setUsers(users.filter(user => user.id !== selectedUser));
    setSelectedUser('');
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Manage Users</Typography>
      <FormControl fullWidth sx={{ mb: 2 }}>
        <InputLabel id="user-select-label">Select User</InputLabel>
        <Select
          labelId="user-select-label"
          value={selectedUser}
          onChange={handleUserChange}
        >
          <MenuItem value=""><em>None</em></MenuItem>
          {users.map(user => (
            <MenuItem key={user.id} value={user.id}>{user.username}</MenuItem>
          ))}
        </Select>
      </FormControl>
      <Button variant="contained" color="secondary" onClick={handleDeleteUser} disabled={!selectedUser}>
        Delete User
      </Button>
    </Box>
  );
};

export default AdminUserManagement;
