
function setup() {
  // Create canvas matching window size
  let canvas = createCanvas(windowWidth, windowHeight);

  // Position canvas as overlay
  canvas.position(0, 0);
  canvas.style('z-index', '5'); // Above video, below info bar
  canvas.style('pointer-events', 'none'); // Allow clicks to pass through

  //blendMode(ADD); // Try: ADD, SCREEN, OVERLAY, MULTIPLY
}

function draw() {
  // Clear with transparency each frame
  clear();


}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
