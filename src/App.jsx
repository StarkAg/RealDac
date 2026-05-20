import React from 'react';
import { Routes, Route } from 'react-router-dom';
import RealDac from './components/RealDac';
import Workspace from './components/Workspace';
import ErrorBoundary from './components/ErrorBoundary';

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<Workspace />} />
        <Route path="/app" element={<RealDac />} />
        <Route path="/app/:roomCode" element={<RealDac />} />
        <Route path="/:roomCode" element={<RealDac />} />
      </Routes>
    </ErrorBoundary>
  );
}
