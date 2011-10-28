"use strict";
this.create = create;
this.invoke = invoke;
this.transform = transform;

var marker = {};
require('fibers');
var jsp = require('uglify-js/lib/parse-js');
var uglify = require('uglify-js/lib/process');

// TODO function declaraction hoisting
// TODO ensure `foo(_)` calls have a bounding fiber. streamline is smart enough to allow this:
// ~function() { foo(_) }();
// and disallow this:
// foo(function() { foo(_) });

/**
 * Creates a function that builds a fiber when called and automatically returns a future.
 *
 * rewrite:
 * function foo(arg, _) {
 *   ...
 * }
 * ->
 * var foo = create(foo(arg, _) {
 *   ...
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
			try {
				memoize(null, fn.apply(that, args));
			} catch (err) {
				memoize(err);
			}
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

/**
 * Transforms code to be streamliney. Line numbers are not maintained, but could be if I could
 * figure out how to do it with uglifyjs.
 */
function transform(source, options) {
	options = options || {};
	var callback = options.callback || '_';
	var didRewrite = false;

	/**
	 * Finds the index of the callback param in an argument list, -1 if not found.
	 */
	function findCallback(args) {
		var idx = -1;
		for (var ii = 0; ii < args.length; ++ii) {
			if (args[ii] === callback || (args[ii][0] === 'name' && args[ii][1] === callback)) {
				if (idx === -1) {
					idx = ii;
				} else {
					throw new Error('Callback argument used more than once in function call');
				}
			}
		}
		didRewrite = true;
		return idx;
	}

	/**
	 * Rewriter for a function expression or declaration
	 */
	function fun(name, args, body) {
		// Sanity check
		if (name === callback) {
			throw new Error('Invalid usage of callback');
		}

		// Find callback arg
		var idx = findCallback(args);
		if (idx === -1) {
			return false;
		}

		// Wrap with fiberize version
		return ['call', ['name', 'fstreamline__.create'], [['function', name, args, body.map(walker.walk)], ['num', idx]]];
	}

	var walker = new uglify.ast_walker;
	var processed = walker.with_walkers({
		'defun': function(name, args, body) {
			var rewrite = fun(name, args, body);
			if (rewrite) {
				return ['var', [[name, rewrite]]];
			}
			return ['defun', name, args, body.map(walker.walk)];
		},
		'function': function(name, args, body) {
			var rewrite = fun(name, args, body);
			if (rewrite) {
				return rewrite;
			}
			return ['function', name, args, body.map(walker.walk)];
		},
		'call': function(expr, args) {
			// If this is an async function then rewrite into a waiting call
			var idx = findCallback(args);
			if (idx === -1) {
				return ['call', walker.walk(expr), args.map(walker.walk)];
			}
			if (idx !== -1) {
				args = ['array', args.map(function(ii) {
					return (ii[0] === 'name' && ii[1] === callback) ? ii : walker.walk(ii);
				})];
				idx = ['num', idx];
				expr = walker.walk(expr);
				if (expr[0] === 'dot') {
					// Calling a method
					return ['call', ['name', 'fstreamline__.invoke'], [expr[1], ['string', expr[2]], args, idx]];
				} else {
					// Calling a function
					return ['call', ['name', 'fstreamline__.invoke'], [['atom', 'null'], expr, args, idx]];
				}
			}
		},
		'name': function(name) {
			if (name === callback) {
				throw new Error('Invalid usage of callback');
			}
			return ['name', name];
		},
	}, function() {
		return walker.walk(jsp.parse(source))
	});

	if (didRewrite) {
		// Wrap with library stuff
		return 'var fstreamline__ = require("fstreamline"); fstreamline__.create(function(_) {\n' +
			uglify.gen_code(processed, {beautify: true}) +
			'\n}).call(this, function(err) {\n  if (err) throw err;\n});';
	} else {
		return source;
	}
}
