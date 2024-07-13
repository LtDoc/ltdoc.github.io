// src/components/ProtectedRoute.js
import React from 'react';
import { Route, Navigate } from 'react-router-dom';

const ProtectedRoute = ({ element: Component, ...rest }) => {
  const authUser = JSON.parse(localStorage.getItem('authUser'));

  return (
    <Route
      {...rest}
      element={authUser ? <Component /> : <Navigate to="/login" />}
    />
  );
};

export default ProtectedRoute;
