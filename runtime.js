"use strict";
this.create = create;
this.invoke = invoke;

require('fibers');

/**
 * Creates a function that builds a fiber when called and automatically returns a future.
 *
 * rewrite:
 * function foo(arg, _) {
 *	 ...
 * }
 * ->
 * var foo = create(foo(arg, _) {
 *	 ...
 * }, 1);
 */
function create(fn, idx) {
	function F() {
		// If there was no callback passed then this function needs to return a future, so setup the
		// bookkeeping for that.
		var cb = arguments[idx];
		var err, val, resolved = false;
		var memoize = cb || function(e, v) {
			err = e;
			val = v;
			resolved = true;
		};

		// Start a new fiber
		var that = this, args = arguments;
		new Fiber(function() {
			var val;
			try {
				val = fn.apply(that, args);
			} catch (err) {
				memoize(err);
			}
			memoize(null, val);
		}).run();

		// Return a future if no callback
		if (!cb) {
			return function(cb) {
				if (resolved) {
					cb(err, val);
				} else {
					memoize = cb;
				}
			};
		}
	};

	// Memoize the original function for fast passing later
	F.fstreamlineFunction = fn;
	return F;
}

/**
 * Invokes an async function and yields currently running fiber until it callsback.
 *
 * rewrite:
 * fs.readFile(file, _);
 * ->
 * invoke(fs, 'readFile', [file], 1);
 */
function invoke(that, fn, args, idx) {
	// Resolve the function to be called
	if (typeof fn === 'string') {
		fn = that[fn];
	}

	// If we're waiting on a fstreamline.create function we can just call it directly instead
	if (fn.fstreamlineFunction) {
		return fn.fstreamlineFunction.apply(that, args);
	}

	// Setup callback to resume fiber after it's yielded
	var fiber = Fiber.current;
	var err, val, yielded = false;
	args[idx] = function(e, v) {
		if (!yielded) {
			yielded = true;
			err = e;
			val = v;
		} else if (e) {
			fiber.throwInto(e);
		} else {
			fiber.run(v);
		}
	};

	// Invoke the function and yield
	fn.apply(that, args);
	if (yielded) {
		if (err) {
			throw err;
		}
		return val;
	}
	yielded = true;
	return Fiber.yield();
}
