
function setup() {
  // Create canvas matching window size
  let canvas = createCanvas(windowWidth, windowHeight);

  // Position canvas as overlay
  canvas.position(0, 0);
  canvas.style('z-index', '5'); // Above video, below info bar
  canvas.style('pointer-events', 'none'); // Allow clicks to pass through

  // Optional: Set blend mode for interesting effects
  // blendMode(ADD); // Try: ADD, SCREEN, OVERLAY, MULTIPLY
}

function draw() {
  // Clear with transparency each frame
  clear();

  // Example: Draw subtle particles
  // Uncomment and customize:

  /*
  noStroke();
  fill(255, 100, 50, 30); // Semi-transparent orange
  let x = random(width);
  let y = random(height);
  circle(x, y, random(2, 8));
  */

  // Example: Pulsing circle in center
  /*
  push();
  translate(width / 2, height / 2);
  noFill();
  stroke(255, 150, 100, 100);
  strokeWeight(2);
  let size = 200 + sin(frameCount * 0.02) * 50;
  circle(0, 0, size);
  pop();
  */

  // Your generative art goes here!
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
