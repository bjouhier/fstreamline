"use strict";
module.exports = Walker;
var t = require('narcissus').definitions.tokenIds;

/**
 * It seems that Narcissus lacks a reasonable node walker. This implements a simple walker which
 * lets you walk a tree linearly, in terms of source code, and only subscribe to the parts that
 * you're interested in.
 */
function Walker(visitors) {
	for (var ii in visitors) {
		visitors[t[ii.toUpperCase()]] = visitors[ii];
	}
	return function walk(node) {
		if (!node) { // this test deals with "return;" statements for example (value is undefined)
			return;
		}
		var type = node.type;
		if (type === undefined) {
			throw new Error('Trying to walk unknown node!');
		}
		switch (type) {
			case t.FUNCTION:
			case t.GETTER:
			case t.SETTER:
				if (visitors[type]) {
					visitors[type].call(node, node.name, node.params, node.body.children);
				} else {
					node.body.children.map(walk);
				}
				break;

			case t.LET_BLOCK:
				if (visitors[type]) {
					visitors[type].call(node, node.variables, node.expression || node.block);
				} else {
					walk(node.variables);
					walk(node.expression || node.block);
				}
				break;

			case t.IF:
				if (visitors[type]) {
					visitors[type].call(node, node.condition, node.thenPart, node.elsePart);
				} else {
					walk(node.condition);
					walk(node.thenPart);
					node.elsePart && walk(node.elsePart);
				}
				break;

			case t.SWITCH:
				if (visitors[type]) {
					visitors[type].call(node, node.discriminant, node.cases);
				} else {
					walk(node.discriminant);
					node.cases.map(walk);
				}
				break;

			case t.FOR:
				if (visitors[type]) {
					visitors[type].call(node, node.setup, node.condition, node.update, node.body);
				} else {
					walk(node.setup);
					walk(node.condition);
					walk(node.update);
					walk(node.body);
				}
				break;

			case t.WHILE:
				if (visitors[type]) {
					visitors[type].call(node, node.condition, node.body);
				} else {
					walk(node.condition);
					walk(node.body);
				}
				break;

			case t.FOR_IN:
				if (visitors[type]) {
					visitors[type].call(node, node.varDecl || node.iterator, node.object, node.body);
				} else {
					walk(node.varDecl || node.iterator);
					walk(node.object);
					walk(node.body);
				}
				break;

			case t.DO:
				if (visitors[type]) {
					visitors[type].call(node, node.condition, node.body);
				} else {
					walk(node.body);
					walk(node.condition);
				}
				break;

			case t.TRY:
				if (visitors[type]) {
					visitors[type].call(node, node.tryBlock, node.catchClauses, node.finallyBlock);
				} else {
					walk(node.tryBlock);
					node.catchClauses.map(walk);
					node.finallyBlock && walk(node.finallyBlock);
				}
				break;

			case t.THROW:
				if (visitors[type]) {
					visitors[type].call(node, node.exception);
				} else {
					walk(node.exception);
				}
				break;

			case t.RETURN:
			case t.YIELD:
				if (visitors[type]) {
					visitors[type].call(node, node.value);
				} else {
					walk(node.value);
				}
				break;

			case t.GENERATOR:
				if (visitors[type]) {
					visitors[type].call(node, node.expression, node.tail);
				} else {
					walk(node.expression);
					walk(node.tail);
				}
				break;

			case t.WITH:
				if (visitors[type]) {
					visitors[type].call(node, node.object, node.body);
				} else {
					walk(node.object);
					walk(node.body);
				}
				break;

			case t.SEMICOLON:
				node.expression && walk(node.expression);
				break;

			case t.LABEL:
				if (visitors[type]) {
					visitors[type].call(node, node.label, node.statement);
				} else {
					walk(node.statement);
				}
				break;

			case t.ARRAY_COMP:
				if (visitors[type]) {
					visitors[type].call(node, node.expression, node.tail);
				} else {
					walk(node.expression);
					walk(node.tail);
				}
				break;

			case t.COMP_TAIL:
				if (visitors[type]) {
					visitors[type].call(node, node.guard, node.children);
				} else {
					walk(node.children);
					walk(node.guard);
				}
				break;

			case t.IDENTIFIER:
				if (visitors[type]) {
					visitors[type].call(node, node.value, node.initializer);
				} else {
					node.initializer && walk(node.initializer);
				}
				break;

			case t.NUMBER:
			case t.REGEXP:
			case t.STRING:
				if (visitors[type]) {
					visitors[type].call(node, node.value);
				}
				break;

			case t.CALL:
				if (visitors[type]) {
					visitors[type].call(node, node.children[0], node.children[1].children);
				} else {
					node.children.map(walk);
				}
				break;

			default:
				if (visitors[type]) {
					visitors[type].call(node);
				} else {
					node.children && node.children.map(walk);
				}
				break;
		}
	};
}
