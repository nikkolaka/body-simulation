# N-Body Gravity Simulator

A WebGL gravity simulator that runs entirely on the GPU. Bodies interact with each other in real-time, paint new ones, and mess around with the physics.

Right now it's doing a brute-force N² calculation for gravity (every body affects every other body), but I'm planning to add Barnes-Hut or something similar later.

## Running it

```bash
npm install
npm start
```
You can pause, step through, restart, or just draw new bodies directly on the canvas. The speed slider goes up to 4x if you want to see it fast.
