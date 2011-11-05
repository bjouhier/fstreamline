"use strict";
this.create = create;
this.invoke = invoke;
this.transform = transform;

require('fibers');
var Narcissus = require('narcissus');
var t = Narcissus.definitions.tokenIds;
var Walker = require('./walker');

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

/**
 * Transforms code to be streamliney. Line numbers are not maintained, but could be if I could
 * figure out how to do it with uglifyjs.
 */
function transform(source, options) {
	options = options || {};
	var callback = options.callback || '_';
	var didRewrite = false;
	var position = 0;
	var buffer = '';

	/**
	 * Adds to `buffer` everything that hasn't been rendered so far.
	 */
	function catchup(node, finish) {
		var until = finish ? node.end : node.start;
		if (until > position) {
			buffer += source.substring(position, until);
			position = until;
		}
	}

	/**
	 * Finds the index of the callback param in an argument list, -1 if not found.
	 */
	function getCallback(args, lineno) {
		var idx = -1;
		for (var ii = 0; ii < args.length; ++ii) {
			if (args[ii] === callback || (args[ii].type === t.IDENTIFIER && args[ii].value === callback)) {
				if (idx === -1) {
					idx = ii;
				} else {
					lineno = lineno || args[ii].lineno;
					throw new Error('Callback argument used more than once in function call on line '+ lineno);
				}
			}
		}
		didRewrite = true;
		return idx;
	}

	var walk = Walker({
		'function': function(name, args, body) {
			catchup(this);
			var idx = getCallback(args, this.lineno);
			if (idx !== -1) {
				// Rewrite streamlined functions
				if (this.functionForm !== 1) {
					buffer += 'var '+ name + ' = ';
				}
				buffer += 'fstreamline__.create(';
				body.map(walk);
				catchup(this, true);
				buffer += ', '+ idx;
				buffer += this.functionForm === 1 ? ')' : ');';
			} else {
				body.map(walk);
			}
		},
		'call': function(expr, args) {
			var idx = getCallback(args);
			if (idx !== -1) {
				// Rewrite streamlined calls
				catchup(this);
				buffer += 'fstreamline__.invoke(';
				if (expr.type === t.DOT) {
					// Method call: foo.bar(_)
					walk(expr.children[0]);
					catchup(expr.children[0], true);
					buffer += ', '+ JSON.stringify(expr.children[1].value);
				} else if (expr.type === t.INDEX) {
					// Dynamic method call: foo[bar](_)
					walk(expr.children[0]);
					catchup(expr.children[0], true);
					buffer += ', ';
					walk(expr.children[1]);
					catchup(expr.children[1], true);
				} else {
					// Function call
					buffer += 'null, ';
					walk(expr);
					catchup(expr, true);
				}
				// Render arguments
				buffer += ', [';
				if (args.length) {
					position = args[0].start;
					for (var ii = 0; ii < args.length; ++ii) {
						if (ii !== idx) {
							walk(args[ii]);
						}
					}
					catchup(args[args.length - 1], true);
				}
				buffer += '], '+ idx+ ')';
				position = this.end + 1; // this.end doesn't include closing paren?
			} else {
				walk(expr);
				args.map(walk);
			}
		},
		'identifier': function(name) {
			if (name === callback) {
				throw new Error('Invalid usage of callback on line '+ this.lineno);
			}
		},
	});

	// Walk parsed source, rendering along the way
	walk(Narcissus.parser.parse(source));
	buffer += source.substring(position);

	if (didRewrite) {
		// Wrap with library stuff
		return 'var fstreamline__ = require("fstreamline"); fstreamline__.create(function(_) {'+
			buffer+
			'\n}).call(this, function(err) {\n	if (err) throw err;\n});';
	} else {
		return source;
	}
}
