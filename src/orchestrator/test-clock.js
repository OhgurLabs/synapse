export function createFakeClock() {
  const originalNow = Date.now;
  const originalDateConstructor = Date;
  let currentTime = originalNow();

  function fakeNow() {
    return currentTime;
  }

  function fakeDate(...args) {
    if (args.length === 0) {
      return new originalDateConstructor(currentTime);
    }
    return new originalDateConstructor(...args);
  }

  fakeDate.now = fakeNow;

  Object.setPrototypeOf(fakeDate, originalDateConstructor);
  fakeDate.prototype = originalDateConstructor.prototype;

  Date.now = fakeNow;
  global.Date = fakeDate;

  return {
    now() {
      return currentTime;
    },
    set(ms) {
      currentTime = ms;
    },
    advance(ms) {
      currentTime += ms;
    },
    restore() {
      Date.now = originalNow;
      global.Date = originalDateConstructor;
    }
  };
}