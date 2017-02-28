/** @flow */
import fs from 'fs-extra';
import glob from 'glob';
import chalk from 'chalk';
import R from 'ramda';
import path from 'path';
import semver from 'semver';
import { BitId } from '../../../bit-id';
import Bit from '../../../consumer/component';
import Consumer from '../../../consumer/consumer';
import loader from '../../../cli/loader';
import { BEFORE_IMPORT_ENVIRONMENT } from '../../../cli/loader/loader-messages';

const key = R.compose(R.head, R.keys);

export default function importAction(
  { bitId, save, tester, compiler, verbose, prefix, environment }: {
    bitId: string,
    save: ?bool,
    tester: ?bool,
    compiler: ?bool,
    verbose: ?bool,
    prefix: ?string,
    environment: ?bool,
  }): Promise<Bit[]> {
  function importEnvironment(consumer) {
    loader.start(BEFORE_IMPORT_ENVIRONMENT);

    return consumer.importEnvironment(bitId, verbose)
    .then((envDependencies) => {
      function writeToBitJsonIfNeeded() {
        if (save && compiler) {
          consumer.bitJson.compilerId = envDependencies[0].id.toString();
          return consumer.bitJson.write({ bitDir: consumer.getPath() });
        }

        if (save && tester) {
          consumer.bitJson.testerId = envDependencies[0].id.toString();
          return consumer.bitJson.write({ bitDir: consumer.getPath() });
        }

        return Promise.resolve(true);
      }
      
      return writeToBitJsonIfNeeded()
      .then(() => ({ envDependencies }));
    });
  }

  const performOnDir = prefix ? path.resolve(prefix) : process.cwd();

  return Consumer.ensure(performOnDir)
    .then(consumer => consumer.scope.ensureDir().then(() => consumer))
    .then((consumer) => {
      if (tester || compiler) { return importEnvironment(consumer); }
      return consumer.import(bitId, verbose, environment)
        .then(({ dependencies, envDependencies }) => {
          if (save) {
            const parseId = BitId.parse(bitId, consumer.scope.name);
            return consumer.bitJson.addDependency(parseId)
            .write({ bitDir: consumer.getPath() })
            .then(() => ({ dependencies, envDependencies }));
          }

          return Promise.resolve(({ dependencies, envDependencies }));
        })
        .then(({ dependencies, envDependencies }) =>
          warnForPackageDependencies({ dependencies, envDependencies, consumer })
          .then(warnings => ({ dependencies, envDependencies, warnings }))
        );
    });
}

const getSemverType = (str): ?string => {
  if (semver.valid(str)) return 'V';
  if (semver.validRange(str)) return 'R';
  return null;
};

function compatibleWith(a: { [string]: string }, b: { [string]: string, }): bool {
  const depName = key(a);
  if (!b[depName]) return false; // dependency does not exist - return false
  const bVersion = b[depName];
  const aVersion = a[depName];
  const aType = getSemverType(aVersion);
  const bType = getSemverType(bVersion);
  if (!aType || !bType) return false; // in case one of the versions is invalid - return false
  if (aType === 'V' && bType === 'V') { return semver.eq(aVersion, bVersion); }
  if (aType === 'V' && bType === 'R') { return semver.satisfies(aVersion, bVersion); }
  if (aType === 'R' && bType === 'V') { return semver.satisfies(bVersion, aVersion); }
  if (aType === 'R' && bType === 'R') { 
    if (aVersion.startsWith('^') && (bVersion.startsWith('^'))) {
      const aMajorVersion = parseInt(aVersion[1], 10);
      const bMajorVersion = parseInt(bVersion[1], 10);
      if (aMajorVersion === bMajorVersion) return true;
    }
  }
  return false;
}

const warnForPackageDependencies = ({ dependencies, envDependencies, consumer }) => {
  const warnings = {
    notInPackageJson: [],
    notInNodeModules: [],
    notInBoth: [],
  };

  const projectDir = consumer.getPath();
  const getPackageJson = (dir) => {
    try {
      return fs.readJSONSync(path.join(dir, 'package.json'));
    } catch (e) { return {}; } // do we want to inform the use that he has no package.json
  };
  const packageJson = getPackageJson(projectDir);
  const packageJsonDependencies = R.merge(
    packageJson.dependencies || {}, packageJson.devDependencies || {}
  );

  const getNameAndVersion = pj => ({ [pj.name]: pj.version });
  const nodeModules = R.mergeAll(
    glob.sync(path.join(projectDir, 'node_modules', '*'))
    .map(R.compose(getNameAndVersion, getPackageJson))
  );

  dependencies.forEach((dep) => {
    if (!dep.packageDependencies || R.isEmpty(dep.packageDependencies)) return null;

    R.forEachObjIndexed((packageDepVersion, packageDepName) => {
      const packageDep = { [packageDepName]: packageDepVersion };
      const compatibleWithPackgeJson = compatibleWith(packageDep, packageJsonDependencies);
      const compatibleWithNodeModules = compatibleWith(packageDep, nodeModules);
      const basicMessage = `the npm package { ${packageDepName}:${packageDepVersion} } is a package dependency of ${dep.id.toString()}`;

      if (!compatibleWithPackgeJson && !compatibleWithNodeModules) {
        warnings.notInBoth.push(packageDep);
      }

      if (!compatibleWithPackgeJson && compatibleWithNodeModules) {
        warnings.notInPackageJson.push(packageDep);
      }

      if (compatibleWithPackgeJson && !compatibleWithNodeModules) {
        warnings.notInNodeModules.push(packageDep);
      }
    }, dep.packageDependencies);
  });

  return Promise.resolve(warnings);
};
