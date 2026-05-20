import React from 'react';
import { Routes, Route } from 'react-router-dom';
import RealDac from './components/RealDac';
import StitchLanding from './components/StitchLanding';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<StitchLanding />} />
      <Route path="/app" element={<RealDac />} />
      <Route path="/app/:roomCode" element={<RealDac />} />
      <Route path="/:roomCode" element={<RealDac />} />
    </Routes>
  );
}
