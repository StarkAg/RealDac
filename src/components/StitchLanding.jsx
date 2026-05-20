import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Float, Sparkles } from '@react-three/drei';

const heroStats = [
  { value: '3D', label: 'motion-heavy hero built in Three.js' },
  { value: 'live', label: 'sync story told before the first click' },
  { value: 'Stitch', label: 'direction shaped through Stitch MCP' },
];

const featureCards = [
  {
    eyebrow: 'Feature Reveal',
    title: 'A front door that explains the room in one glance',
    body:
      'The page frames RealDac as a launch, not a utility. People understand sync, invites, and shared playback before they enter the app.',
  },
  {
    eyebrow: 'Motion Layering',
    title: '3D elements and moving panels keep the page feeling alive',
    body:
      'Floating geometry, animated HUD cards, and soft parallax give the feature weight without turning the page into visual noise.',
  },
  {
    eyebrow: 'Technical Story',
    title: 'It speaks to people already building with Stitch MCP',
    body:
      'The copy is product-facing, the layout is editorial, and the architecture callouts make it clear this is demo-ready engineering.',
  },
  {
    eyebrow: 'Fast Handoff',
    title: 'One CTA moves from showcase into the actual synced room',
    body:
      'The landing page sells the experience, then hands people directly into the working RealDac flow instead of stopping at a mock.',
  },
];

const architectureCards = [
  {
    title: 'Realtime pulse',
    copy: 'Socket events keep countdown, pause, and track changes moving as one shared beat.',
  },
  {
    title: 'Room memory',
    copy: 'Convex persistence keeps state recoverable when people reconnect or reopen the room.',
  },
  {
    title: 'Invite design',
    copy: 'Links, codes, and QR entry reduce friction so the feature feels social immediately.',
  },
];

const useCases = [
  {
    title: 'For Stitch MCP builders',
    copy: 'Use it as the polished explanation layer when a raw prototype is not enough to sell the idea.',
  },
  {
    title: 'For product teams',
    copy: 'Lead with the outcome, not the implementation, and let the hero section do the first minute of the pitch.',
  },
  {
    title: 'For community launches',
    copy: 'Turn a shared-room feature into a thing people want to join instead of a thing they need explained.',
  },
];

const workflowSteps = [
  {
    index: '01',
    title: 'Shape the concept in Stitch MCP',
    body: 'Use Stitch to frame the structure, pacing, and product narrative for the page.',
  },
  {
    index: '02',
    title: 'Translate it into a cinematic React surface',
    body: 'Three.js powers the hero while layered panels, glass, and typography keep the page premium.',
  },
  {
    index: '03',
    title: 'Drop people into the live feature',
    body: 'The final CTA opens the actual RealDac room flow so the story and product stay connected.',
  },
];

function SignalCluster() {
  const clusterRef = useRef(null);
  const torusRef = useRef(null);
  const slabRef = useRef(null);
  const haloRef = useRef(null);
  const satelliteRef = useRef(null);

  useFrame((state, delta) => {
    const time = state.clock.elapsedTime;

    if (clusterRef.current) {
      clusterRef.current.rotation.y += delta * 0.18;
      clusterRef.current.rotation.x = Math.sin(time * 0.3) * 0.16;
      clusterRef.current.rotation.z = Math.cos(time * 0.24) * 0.08;
      clusterRef.current.position.y = Math.sin(time * 0.8) * 0.08;
    }

    if (torusRef.current) {
      torusRef.current.rotation.x += delta * 0.42;
      torusRef.current.rotation.y -= delta * 0.25;
      torusRef.current.rotation.z += delta * 0.16;
    }

    if (slabRef.current) {
      slabRef.current.rotation.z = 0.22 + Math.sin(time * 0.55) * 0.08;
      slabRef.current.rotation.x = -0.42 + Math.cos(time * 0.4) * 0.04;
    }

    if (haloRef.current) {
      haloRef.current.rotation.y += delta * 0.3;
      haloRef.current.rotation.z += delta * 0.22;
    }

    if (satelliteRef.current) {
      satelliteRef.current.position.x = 1.75 + Math.sin(time * 1.2) * 0.14;
      satelliteRef.current.position.y = -0.3 + Math.cos(time * 1.1) * 0.2;
      satelliteRef.current.rotation.y -= delta * 0.55;
      satelliteRef.current.rotation.z += delta * 0.25;
    }
  });

  return (
    <group ref={clusterRef}>
      <Float speed={1.2} rotationIntensity={0.45} floatIntensity={0.8}>
        <mesh position={[-1.05, 0.25, -0.12]}>
          <icosahedronGeometry args={[1.02, 1]} />
          <meshPhysicalMaterial
            color="#d4ecff"
            emissive="#3a8eff"
            emissiveIntensity={0.65}
            metalness={0.45}
            roughness={0.08}
            transmission={0.34}
            thickness={1.8}
            clearcoat={1}
          />
        </mesh>
      </Float>

      <Float speed={1.85} rotationIntensity={0.7} floatIntensity={1}>
        <mesh ref={torusRef} position={[0.58, 0.14, 0.4]}>
          <torusKnotGeometry args={[0.82, 0.18, 220, 30]} />
          <meshStandardMaterial
            color="#ff9c42"
            emissive="#ff7d1d"
            emissiveIntensity={0.9}
            metalness={0.76}
            roughness={0.14}
          />
        </mesh>
      </Float>

      <Float speed={1} rotationIntensity={0.28} floatIntensity={0.55}>
        <mesh ref={slabRef} position={[0.18, -1.05, -0.16]} rotation={[-0.42, 0.5, 0.22]}>
          <boxGeometry args={[2.4, 0.22, 1.18]} />
          <meshPhysicalMaterial
            color="#b8d7ff"
            emissive="#1749a8"
            emissiveIntensity={0.3}
            metalness={0.12}
            roughness={0.02}
            transmission={0.82}
            thickness={2.2}
            clearcoat={1}
          />
        </mesh>
      </Float>

      <Float speed={1.4} rotationIntensity={0.2} floatIntensity={0.5}>
        <mesh ref={haloRef} position={[-0.25, 0.85, -0.82]} rotation={[1.15, 0.18, 0.44]}>
          <torusGeometry args={[1.68, 0.035, 24, 180]} />
          <meshStandardMaterial color="#8cc9ff" emissive="#2c7fff" emissiveIntensity={0.58} metalness={0.92} roughness={0.22} />
        </mesh>
      </Float>

      <Float speed={2.2} rotationIntensity={0.8} floatIntensity={1.25}>
        <group ref={satelliteRef} position={[1.75, -0.3, 0.3]}>
          <mesh>
            <octahedronGeometry args={[0.42, 0]} />
            <meshPhysicalMaterial
              color="#fff1d9"
              emissive="#ffab54"
              emissiveIntensity={0.58}
              metalness={0.34}
              roughness={0.05}
              transmission={0.56}
              thickness={1.6}
              clearcoat={1}
            />
          </mesh>
          <mesh position={[0, 0.68, 0]} scale={[0.38, 1.15, 0.38]}>
            <cylinderGeometry args={[0.28, 0.18, 0.88, 10]} />
            <meshStandardMaterial color="#ffe2bb" emissive="#ff9b43" emissiveIntensity={0.46} metalness={0.5} roughness={0.18} />
          </mesh>
        </group>
      </Float>
    </group>
  );
}

function HeroScene() {
  return (
    <Canvas camera={{ position: [0, 0.1, 5.8], fov: 36 }} dpr={[1, 2]}>
      <color attach="background" args={['#060d14']} />
      <fog attach="fog" args={['#060d14', 6.5, 13]} />
      <ambientLight intensity={1.1} />
      <directionalLight position={[4, 5, 4]} intensity={3.8} color="#b9ddff" />
      <pointLight position={[-4, -2, 3]} intensity={24} color="#3d87ff" />
      <pointLight position={[4, -1, 2]} intensity={26} color="#ff8a2f" />
      <SignalCluster />
      <Sparkles count={110} scale={[8, 5.5, 6]} size={2.1} speed={0.45} color="#dcefff" />
      <ContactShadows position={[0, -2.25, 0]} opacity={0.44} scale={10} blur={2.6} far={4.8} />
    </Canvas>
  );
}

export default function StitchLanding() {
  const pageRef = useRef(null);

  useEffect(() => {
    if (!pageRef.current) return;
    pageRef.current.style.setProperty('--pointer-x', '52%');
    pageRef.current.style.setProperty('--pointer-y', '18%');
  }, []);

  const updatePointer = (event) => {
    if (!pageRef.current) return;
    const bounds = pageRef.current.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 100;
    const y = ((event.clientY - bounds.top) / bounds.height) * 100;
    pageRef.current.style.setProperty('--pointer-x', `${x.toFixed(2)}%`);
    pageRef.current.style.setProperty('--pointer-y', `${y.toFixed(2)}%`);
  };

  const resetPointer = () => {
    if (!pageRef.current) return;
    pageRef.current.style.setProperty('--pointer-x', '52%');
    pageRef.current.style.setProperty('--pointer-y', '18%');
  };

  return (
    <main ref={pageRef} className="stitch-page" onPointerMove={updatePointer} onPointerLeave={resetPointer}>
      <div className="stitch-page-noise" />
      <div className="stitch-page-aurora" />

      <header className="stitch-nav">
        <Link className="stitch-brand" to="/">
          <span className="stitch-brand-mark">RD</span>
          <span>
            RealDac
            <small>Feature intro for Stitch MCP audiences</small>
          </span>
        </Link>

        <nav className="stitch-nav-links">
          <a href="#features">Features</a>
          <a href="#architecture">Architecture</a>
          <Link to="/app">Launch Demo</Link>
        </nav>
      </header>

      <section className="stitch-hero">
        <div className="stitch-hero-copy">
          <div className="stitch-chip-row">
            <span className="stitch-chip">Stitch MCP</span>
            <span className="stitch-chip stitch-chip-muted">Three.js hero</span>
            <span className="stitch-chip stitch-chip-muted">Sleek launch surface</span>
          </div>

          <p className="stitch-kicker">Show the feature before you explain the feature</p>
          <h1>Introduce RealDac to other Stitch MCP users with depth, motion, and a premium story.</h1>
          <p className="stitch-lead">
            This page is designed as a polished feature reveal. It uses Stitch MCP direction, a live Three.js centerpiece,
            animated interface layers, and clear product framing so other builders instantly understand what RealDac does.
          </p>

          <div className="stitch-actions">
            <Link className="stitch-button stitch-button-primary" to="/app">
              Launch Live Demo
            </Link>
            <a className="stitch-button stitch-button-secondary" href="#architecture">
              Explore Architecture
            </a>
          </div>

          <div className="stitch-stat-grid">
            {heroStats.map((item) => (
              <article className="stitch-stat-card" key={item.label}>
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </article>
            ))}
          </div>

          <div className="stitch-mini-marquee" aria-hidden="true">
            <div className="stitch-mini-marquee-track">
              <span>Realtime sync</span>
              <span>Shared room state</span>
              <span>Invite flow</span>
              <span>Stitch MCP concept</span>
              <span>Three.js motion</span>
              <span>Launch-ready surface</span>
              <span>Realtime sync</span>
              <span>Shared room state</span>
              <span>Invite flow</span>
              <span>Stitch MCP concept</span>
              <span>Three.js motion</span>
              <span>Launch-ready surface</span>
            </div>
          </div>
        </div>

        <div className="stitch-hero-visual">
          <div className="stitch-floating-card stitch-floating-card-top">
            <span>Stitch MCP direction</span>
            <strong>Concept to coded experience</strong>
          </div>

          <div className="stitch-floating-card stitch-floating-card-middle">
            <span>Why it lands</span>
            <strong>Story, motion, and architecture in one screen</strong>
          </div>

          <div className="stitch-visual-shell">
            <div className="stitch-visual-grid" />
            <HeroScene />

            <div className="stitch-status-stack">
              <article className="stitch-status-card">
                <span>Signal</span>
                <strong>Socket + Convex room sync</strong>
                <p>Countdowns, pause events, and track changes stay coordinated across listeners.</p>
              </article>
              <article className="stitch-status-card">
                <span>Entry</span>
                <strong>Share code, link, or QR</strong>
                <p>The landing page sells the room, then the invite flow gets everyone into it quickly.</p>
              </article>
            </div>
          </div>

          <div className="stitch-console">
            <div className="stitch-console-chrome">
              <span />
              <span />
              <span />
            </div>
            <div className="stitch-console-line">$ npm run dev:all</div>
            <div className="stitch-console-line">stitch concept -&gt; coded hero</div>
            <div className="stitch-console-line">app route -&gt; /app</div>
          </div>
        </div>
      </section>

      <section className="stitch-proof">
        <div className="stitch-section-heading">
          <p className="stitch-section-tag">Why this page works</p>
          <h2>It feels like a launch asset, but it still points straight at the real product.</h2>
        </div>

        <div className="stitch-proof-grid">
          <article className="stitch-proof-card">
            <strong>Clear framing</strong>
            <span>The headline and hero explain the value fast enough for people seeing RealDac for the first time.</span>
          </article>
          <article className="stitch-proof-card">
            <strong>Moving surface</strong>
            <span>3D geometry, floating interface cards, and ambient animation make the page feel engineered, not templated.</span>
          </article>
          <article className="stitch-proof-card">
            <strong>Useful to builders</strong>
            <span>Stitch MCP users get both the product narrative and the implementation signal in the same landing page.</span>
          </article>
        </div>
      </section>

      <section className="stitch-section" id="features">
        <div className="stitch-section-heading">
          <p className="stitch-section-tag">Feature stack</p>
          <h2>Every section is tuned to introduce the feature to other people building with Stitch MCP.</h2>
        </div>

        <div className="stitch-feature-grid">
          {featureCards.map((card) => (
            <article className="stitch-feature-card" key={card.title}>
              <span>{card.eyebrow}</span>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="stitch-section" id="architecture">
        <div className="stitch-architecture">
          <div className="stitch-section-heading">
            <p className="stitch-section-tag">Architecture story</p>
            <h2>Built to feel sleek on the surface and credible underneath.</h2>
            <p className="stitch-section-copy">
              The page keeps the message high level, but it still signals what matters: realtime coordination, persistent room
              state, and a frictionless path from the hero into the working experience.
            </p>
          </div>

          <div className="stitch-architecture-grid">
            {architectureCards.map((card) => (
              <article className="stitch-architecture-card" key={card.title}>
                <strong>{card.title}</strong>
                <p>{card.copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="stitch-section">
        <div className="stitch-section-heading">
          <p className="stitch-section-tag">Workflow</p>
          <h2>A simple reveal path from Stitch MCP idea to live demo.</h2>
        </div>

        <div className="stitch-process-grid">
          {workflowSteps.map((step) => (
            <article className="stitch-process-card" key={step.index}>
              <span>{step.index}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="stitch-section">
        <div className="stitch-section-heading">
          <p className="stitch-section-tag">Who it helps</p>
          <h2>Useful when you need other people to understand the feature fast.</h2>
        </div>

        <div className="stitch-use-grid">
          {useCases.map((item) => (
            <article className="stitch-use-card" key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="stitch-cta">
        <div>
          <p className="stitch-section-tag">Next step</p>
          <h2>Use the page to introduce the feature, then send people into the synced room and let RealDac prove itself.</h2>
        </div>

        <Link className="stitch-button stitch-button-primary" to="/app">
          Enter RealDac
        </Link>
      </section>
    </main>
  );
}
